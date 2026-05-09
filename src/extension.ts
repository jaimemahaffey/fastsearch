import * as path from 'node:path';
import * as vscode from 'vscode';
import { getDeclarations, getDefinitions, getDocumentSymbols, getHoverSummary, getImplementationsAt, getReferencesAt, getTypeDefinitions } from './bridge/providerBridge';
import { createCycleSearchModeCommand } from './commands/cycleSearchMode';
import { findImplementations } from './commands/findImplementations';
import { findUsages } from './commands/findUsages';
import { goToFile } from './commands/goToFile';
import { rebuildIndex } from './commands/rebuildIndex';
import { goToSymbol } from './commands/goToSymbol';
import { goToText } from './commands/goToText';
import { readConfig, requiresRebuild } from './configuration';
import { IndexCoordinator, shouldYield } from './core/indexCoordinator';
import { createIgnoreMatcher, loadConfiguredIgnoreMatcher, type IgnoreMatcher } from './core/ignoreRules';
import { PersistenceStore, type PersistedWorkspaceSnapshot } from './core/persistenceStore';
import { shouldProcessUpdateJob, WORKSPACE_FILE_EXCLUDE_GLOB, type UpdateJob, type WatcherPathFilters } from './core/workspaceWatcher';
import { FileIndex } from './indexes/fileIndex';
import { SymbolIndex } from './indexes/symbolIndex';
import { TextIndex } from './indexes/textIndex';
import { SemanticEnrichmentService } from './semantics/semanticEnrichmentService';
import { SemanticIndex } from './semantics/semanticIndex';
import { isEligibleTextFile } from './shared/fileEligibility';
import type { FastIndexerConfig } from './configuration';
import type { WorkspacePersistence } from './shared/types';

const INITIAL_INDEXES_WARMING_MESSAGE = 'Building initial indexes. Please wait a moment.';
const INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE = 'Initial index build is still running. Please wait for it to finish before rebuilding.';
const INDEXING_DISABLED_MESSAGE = 'Fast Symbol Indexer indexing is disabled.';
const INDEX_BUILD_YIELD_INTERVAL = 50;
const PERSISTENCE_SCHEMA_VERSION = 2;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Fast Symbol Indexer');
  const getConfig = () => readConfig();
  const config = getConfig();
  const fileIndex = new FileIndex();
  const symbolIndex = new SymbolIndex();
  const textIndex = new TextIndex();
  const semanticIndex = new SemanticIndex();
  let semanticService = createSemanticService(semanticIndex, config, output);
  const persistenceStore = new PersistenceStore(context.globalStorageUri?.fsPath ?? context.storageUri?.fsPath ?? '.fast-indexer-cache');
  const workspacePersistence = getWorkspacePersistence();
  let activeIgnoreMatcher: IgnoreMatcher = createIgnoreMatcher({
    exclude: config.exclude,
    ignoreRules: []
  });
  let activePersistenceConfigHash = createPersistenceConfigHash(config, []);
  let configuredIgnoreFilePaths = new Set<string>();
  let buildGeneration = 0;
  const refreshIgnoreMatcher = async (): Promise<IgnoreMatcher> => {
    const loadedIgnoreMatcher = await loadConfiguredIgnoreMatcher(
      vscode.workspace.fs,
      getConfig(),
      vscode.workspace.workspaceFolders ?? [],
      vscode.workspace.workspaceFile
    );
    loadedIgnoreMatcher.diagnostics.forEach((message) => output.appendLine(message));
    activeIgnoreMatcher = loadedIgnoreMatcher.matcher;
    activePersistenceConfigHash = createPersistenceConfigHash(getConfig(), loadedIgnoreMatcher.persistenceInputs);
    configuredIgnoreFilePaths = new Set(
      loadedIgnoreMatcher.resolvedIgnoreFiles.map((entry) => normalizeWorkspaceFilePath(entry.ignoreFilePath))
    );
    return loadedIgnoreMatcher.matcher;
  };
  const buildWorkspace = async () => {
    const generation = ++buildGeneration;
    const currentConfig = getConfig();
    const ignoreMatcher = await refreshIgnoreMatcher();
    const completed = await buildWorkspaceIndexes(
      fileIndex,
      symbolIndex,
      textIndex,
      semanticService,
      generation,
      currentConfig,
      ignoreMatcher,
      output,
      () => getConfig().enabled && generation === buildGeneration
    );

    if (completed !== false && getConfig().enabled) {
      await persistenceStore.writeWorkspaceSnapshot(
        workspacePersistence.workspaceId,
        createPersistedWorkspaceSnapshot(workspacePersistence, activePersistenceConfigHash, fileIndex, symbolIndex, textIndex, semanticIndex)
      );
    }

    return completed;
  };
  const coordinator = new IndexCoordinator({
    clearIndexes: () => {
      semanticService.cancelGeneration(buildGeneration);
      semanticService.clear();
      fileIndex.clear();
      symbolIndex.clear();
      textIndex.clear();
      semanticIndex.clear();
    },
    clearPersistence: async () => persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId),
    buildWorkspace
  });
  let initialFileIndexBuildPending = config.enabled;
  let rebuildQueued = false;
  let rebuildInFlight = false;
  let rebuildTimeout: NodeJS.Timeout | undefined;
  let initialIndexPromise: Promise<void> = Promise.resolve();
  let initialSnapshotRestorePending = false;
  let initialSnapshotPromise: Promise<void> = Promise.resolve();
  let restoredSnapshotReady = false;
  let initialBuildToken = 0;

  const runQueuedRebuild = (): void => {
    if (initialFileIndexBuildPending || rebuildInFlight) {
      return;
    }

    rebuildQueued = false;
    rebuildTimeout = setTimeout(() => {
      rebuildTimeout = undefined;
      rebuildInFlight = true;
      void coordinator.rebuild()
        .catch((error) => {
          output.appendLine(`Failed to refresh workspace indexes: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          rebuildInFlight = false;
          if (rebuildQueued) {
            runQueuedRebuild();
          }
        });
    }, getConfig().debounceMs);
  };

  const queueWorkspaceRefresh = (): void => {
    if (!getConfig().enabled) {
      return;
    }

    rebuildQueued = true;
    coordinator.markStale();

    if (rebuildTimeout) {
      clearTimeout(rebuildTimeout);
      rebuildTimeout = undefined;
    }

    runQueuedRebuild();
  };

  const queueWorkspaceRefreshForJob = (job: UpdateJob): void => {
    if (job.filePath && configuredIgnoreFilePaths.has(normalizeWorkspaceFilePath(job.filePath))) {
      void refreshIgnoreMatcher()
        .catch((error) => {
          output.appendLine(`Failed to refresh ignore matcher: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          queueWorkspaceRefresh();
        });
      return;
    }

    if (!shouldProcessUpdateJob(job, getWatcherFilters(getConfig(), activeIgnoreMatcher))) {
      return;
    }

    queueWorkspaceRefresh();
  };

  const beginBuildGate = (runner: () => Promise<boolean | void>): void => {
    const buildToken = ++initialBuildToken;
    initialFileIndexBuildPending = true;
    initialIndexPromise = runner()
      .then((completed) => {
        if (buildToken !== initialBuildToken) {
          return;
        }

        if (completed === false || !getConfig().enabled) {
          coordinator.markStale();
          return;
        }

        coordinator.markReady();
      })
      .catch((error) => {
        if (buildToken !== initialBuildToken) {
          return;
        }

        coordinator.markStale();
        output.appendLine(`Failed to build workspace indexes: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (buildToken !== initialBuildToken) {
          return;
        }

        initialFileIndexBuildPending = false;
        if (rebuildQueued) {
          runQueuedRebuild();
        }
      });
  };

  const startInitialBuild = (): void => {
    coordinator.markWarming();
    restoredSnapshotReady = false;
    initialSnapshotRestorePending = true;
    initialSnapshotPromise = restorePersistedSnapshot(
      persistenceStore,
      workspacePersistence,
      refreshIgnoreMatcher,
      () => activePersistenceConfigHash,
      fileIndex,
      symbolIndex,
      textIndex,
      semanticIndex
    )
      .then((restored) => {
        restoredSnapshotReady = restored;
      })
      .catch((error) => {
        restoredSnapshotReady = false;
        output.appendLine(`Failed to restore persisted workspace snapshot: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        initialSnapshotRestorePending = false;
        beginBuildGate(buildWorkspace);
      });
  };

  const startConfigRebuild = (): void => {
    if (rebuildTimeout) {
      clearTimeout(rebuildTimeout);
      rebuildTimeout = undefined;
    }

    rebuildQueued = false;
    semanticService.cancelGeneration(buildGeneration);
    buildGeneration += 1;
    semanticService = createSemanticService(semanticIndex, getConfig(), output);
    coordinator.markStale();
    beginBuildGate(() => coordinator.rebuild());
  };

  const waitForCurrentBuild = async (): Promise<boolean> => {
    if (initialSnapshotRestorePending) {
      await initialSnapshotPromise;
    }

    while (initialFileIndexBuildPending) {
      const token = initialBuildToken;
      await initialIndexPromise;
      if (token === initialBuildToken) {
        break;
      }
    }

    return getConfig().enabled;
  };

  const waitForInitialSnapshotRestore = async (): Promise<void> => {
    if (initialSnapshotRestorePending) {
      await initialSnapshotPromise;
    }
  };

  if (config.enabled) {
    startInitialBuild();
  }

  if (!config.enabled) {
    coordinator.markStale();
    output.appendLine('Background indexing disabled by configuration.');
  }

  output.appendLine(`fastIndexer enabled=${config.enabled}`);
  const cycleLog = (message: string): void => {
    output.appendLine(`[cycle] ${message}`);
  };
  const cycleSearchMode = createCycleSearchModeCommand(fileIndex, textIndex, symbolIndex, getConfig, cycleLog, semanticIndex);

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.cycleSearchMode', async () => {
    cycleLog('command invoked');
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !restoredSnapshotReady) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    if (!restoredSnapshotReady && !await waitForCurrentBuild()) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await cycleSearchMode.execute();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
    cycleSearchMode.reset();
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !restoredSnapshotReady) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    if (!restoredSnapshotReady && !await waitForCurrentBuild()) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToFile(fileIndex, getConfig());
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToText', async () => {
    cycleSearchMode.reset();
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !restoredSnapshotReady) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    if (!restoredSnapshotReady && !await waitForCurrentBuild()) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToText(textIndex, getConfig());
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToSymbol', async () => {
    cycleSearchMode.reset();
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await waitForInitialSnapshotRestore();

    if (initialFileIndexBuildPending && !restoredSnapshotReady) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    if (!restoredSnapshotReady && !await waitForCurrentBuild()) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToSymbol(symbolIndex, getConfig(), {}, {}, semanticIndex);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.rebuildIndex', async () => {
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE);
      return;
    }

    await rebuildIndex(coordinator);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.findUsages', async () => {
    const currentConfig = getConfig();
    if (!currentConfig.enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    const allowFallback = currentConfig.enabled && currentConfig.providerFallback;
    await findUsages(textIndex, symbolIndex, {
      allowTextFallback: allowFallback,
      allowSymbolFallback: allowFallback && currentConfig.symbolFallback,
      completionStyleResults: currentConfig.completionStyleResults,
      fuzzySearch: currentConfig.fuzzySearch,
      useFzf: currentConfig.useFzf,
      awaitFallbackReady: allowFallback
          ? async () => {
            if (initialFileIndexBuildPending) {
              void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
            }

            if (!await waitForCurrentBuild()) {
              void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
              return false;
            }

            return true;
          }
        : undefined
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.findImplementations', async () => {
    const currentConfig = getConfig();
    if (!currentConfig.enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    const allowSymbolFallback = currentConfig.enabled && currentConfig.providerFallback && currentConfig.symbolFallback;
    await findImplementations(symbolIndex, {
      allowSymbolFallback,
      completionStyleResults: currentConfig.completionStyleResults,
      fuzzySearch: currentConfig.fuzzySearch,
      useFzf: currentConfig.useFzf,
      awaitFallbackReady: allowSymbolFallback
          ? async () => {
            if (initialFileIndexBuildPending) {
              void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
            }

            if (!await waitForCurrentBuild()) {
              void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
              return false;
            }

            return true;
          }
        : undefined
    });
  }));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'create',
        relativePath: vscode.workspace.asRelativePath(uri, false),
        filePath: uri.fsPath
      });
    }),
    watcher.onDidChange((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'change',
        relativePath: vscode.workspace.asRelativePath(uri, false),
        filePath: uri.fsPath
      });
    }),
    watcher.onDidDelete((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'delete',
        relativePath: vscode.workspace.asRelativePath(uri, false),
        filePath: uri.fsPath
      });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('fastIndexer.enabled')) {
        if (!getConfig().enabled) {
          if (rebuildTimeout) {
            clearTimeout(rebuildTimeout);
            rebuildTimeout = undefined;
          }

          initialBuildToken += 1;
          semanticService.cancelGeneration(buildGeneration);
          buildGeneration += 1;
          semanticService.clear();
          rebuildQueued = false;
          rebuildInFlight = false;
          fileIndex.clear();
          symbolIndex.clear();
          textIndex.clear();
          semanticIndex.clear();
          coordinator.markStale();
          initialFileIndexBuildPending = false;
          output.appendLine('Background indexing disabled by configuration.');
          return;
        }

        startInitialBuild();
        return;
      }

      if (requiresRebuild(event) && getConfig().enabled) {
        startConfigRebuild();
      }
    })
  );

  context.subscriptions.push(
    output,
    {
      dispose: () => {
        semanticService.cancelGeneration(buildGeneration);
        semanticService.clear();
      }
    }
  );
}

async function buildWorkspaceIndexes(
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticService: SemanticEnrichmentService,
  generation: number,
  config: FastIndexerConfig,
  ignoreMatcher: IgnoreMatcher,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean
): Promise<boolean> {
  try {
    if (config.include.length === 0) {
      return true;
    }

    const files = await vscode.workspace.findFiles(
      toGlobExpression(config.include, '**/*'),
      toGlobExpression([WORKSPACE_FILE_EXCLUDE_GLOB, ...config.exclude], WORKSPACE_FILE_EXCLUDE_GLOB)
    );

    let processedFiles = 0;
    for (const file of files) {
      if (!shouldContinue()) {
        return false;
      }

      const relativePath = vscode.workspace.asRelativePath(file, true);
      if (ignoreMatcher.ignores(file.fsPath, relativePath)) {
        processedFiles += 1;
        if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles)) {
          await yieldToEventLoop();
        }
        continue;
      }

      fileIndex.upsert(relativePath, file.toString(), toIndexedFileKey(file, relativePath));

      try {
        const symbols = await getDocumentSymbols(file);
        if (!shouldContinue()) {
          return false;
        }

        symbolIndex.replaceForFile(relativePath, symbols);
        semanticService.enqueueFile(relativePath, symbols, generation);
      } catch (error) {
        output.appendLine(`Failed to read ${relativePath} for symbol indexing: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const content = await readEligibleTextContent(vscode.workspace.fs, file, relativePath, config.maxFileSizeKb);
        if (!shouldContinue()) {
          return false;
        }

        if (content !== undefined) {
          textIndex.upsert(relativePath, file.toString(), content);
        }
      } catch (error) {
        output.appendLine(`Failed to read ${relativePath} for text indexing: ${error instanceof Error ? error.message : String(error)}`);
      }

      processedFiles += 1;
      if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, processedFiles)) {
        await yieldToEventLoop();
      }
    }

    return true;
  } catch (error) {
    output.appendLine(`Failed to build initial file index: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function readEligibleTextContent(
  fileSystem: Pick<typeof vscode.workspace.fs, 'stat' | 'readFile'>,
  file: vscode.Uri,
  relativePath: string,
  maxFileSizeKb: number
): Promise<string | undefined> {
  const stat = await fileSystem.stat(file);
  if (!isEligibleTextFile(relativePath, stat.size, maxFileSizeKb)) {
    return undefined;
  }

  const bytes = await fileSystem.readFile(file);
  return Buffer.from(bytes).toString('utf8');
}

async function restorePersistedSnapshot(
  persistenceStore: PersistenceStore,
  workspacePersistence: WorkspacePersistence,
  refreshIgnoreMatcher: () => Promise<IgnoreMatcher>,
  getPersistenceConfigHash: () => string,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): Promise<boolean> {
  try {
    await refreshIgnoreMatcher();
    const snapshot = await persistenceStore.readWorkspaceSnapshot(workspacePersistence.workspaceId);
    if (!snapshot) {
      return false;
    }

    if (!isPersistedSnapshotValid(snapshot, workspacePersistence, getPersistenceConfigHash())) {
      await persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId);
      return false;
    }

    hydrateIndexesFromSnapshot(snapshot, fileIndex, symbolIndex, textIndex, semanticIndex);
    return true;
  } catch (error) {
    await persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function hydrateIndexesFromSnapshot(
  snapshot: PersistedWorkspaceSnapshot,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): void {
  fileIndex.clear();
  symbolIndex.clear();
  textIndex.clear();
  semanticIndex.clear();

  snapshot.fileIndex.forEach((entry) => {
    fileIndex.upsert(entry.relativePath, entry.uri, toIndexedSnapshotKey(entry));
  });
  snapshot.textIndex.forEach((entry) => {
    textIndex.upsert(entry.relativePath, entry.uri, entry.content);
  });
  snapshot.symbolIndex.forEach((entry) => {
    symbolIndex.replaceForFile(entry.relativePath, entry.symbols);
  });
  snapshot.semanticIndex?.forEach((entry) => {
    semanticIndex.replaceForFile(entry.relativePath, entry.entries);
  });
}

function createPersistedWorkspaceSnapshot(
  workspacePersistence: WorkspacePersistence,
  persistenceConfigHash: string,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): PersistedWorkspaceSnapshot {
  return {
    metadata: {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      workspaceId: workspacePersistence.workspaceId,
      configHash: persistenceConfigHash
    },
    fileIndex: fileIndex.all(),
    textIndex: textIndex.allContents(),
    symbolIndex: symbolIndex.allByFile(),
    semanticIndex: semanticIndex.allByFile()
  };
}

function toIndexedFileKey(file: vscode.Uri, relativePath: string): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
  if (!workspaceFolder) {
    return relativePath;
  }

  return `${workspaceFolder.uri.toString()}::${relativePath}`;
}

function toIndexedSnapshotKey(entry: PersistedWorkspaceSnapshot['fileIndex'][number]): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(entry.uri));
  if (!workspaceFolder) {
    return entry.relativePath;
  }

  return `${workspaceFolder.uri.toString()}::${entry.relativePath}`;
}

function createPersistenceConfigHash(
  config: FastIndexerConfig,
  ignoreInputs: Array<{ path: string; rules?: string[]; missing?: boolean; }>
): string {
  return JSON.stringify({
    include: config.include,
    exclude: config.exclude,
    ignoreFiles: config.ignoreFiles,
    sharedIgnoreFiles: config.sharedIgnoreFiles,
    ignoreInputs,
    maxFileSizeKb: config.maxFileSizeKb,
    semanticEnrichment: config.semanticEnrichment,
    semanticConcurrency: config.semanticConcurrency,
    semanticTimeoutMs: config.semanticTimeoutMs
  });
}

function isPersistedSnapshotValid(
  snapshot: PersistedWorkspaceSnapshot,
  workspacePersistence: WorkspacePersistence,
  persistenceConfigHash: string
): boolean {
  return snapshot.metadata.schemaVersion === PERSISTENCE_SCHEMA_VERSION
    && snapshot.metadata.workspaceId === workspacePersistence.workspaceId
    && snapshot.metadata.configHash === persistenceConfigHash;
}

function getWorkspacePersistence(): WorkspacePersistence {
  const workspaceFolderUris = (vscode.workspace.workspaceFolders ?? [])
    .map((workspaceFolder) => workspaceFolder.uri.toString())
    .sort();

  if (workspaceFolderUris.length === 0) {
    return {
      workspaceId: 'workspace'
    };
  }

  if (workspaceFolderUris.length === 1) {
    return {
      workspaceId: encodeURIComponent(workspaceFolderUris[0]!)
    };
  }

  return {
    workspaceId: encodeURIComponent(JSON.stringify(workspaceFolderUris))
  };
}

function toGlobExpression(patterns: string[], fallback: string): string {
  const normalized = patterns.filter((pattern) => pattern.trim().length > 0);
  if (normalized.length === 0) {
    return fallback;
  }

  if (normalized.length === 1) {
    return normalized[0]!;
  }

  return `{${normalized.join(',')}}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function getWatcherFilters(config: FastIndexerConfig, ignoreMatcher: IgnoreMatcher): WatcherPathFilters {
  return {
    include: config.include,
    exclude: config.exclude,
    ignoreMatcher
  };
}

function createSemanticService(
  semanticIndex: SemanticIndex,
  config: FastIndexerConfig,
  output: vscode.OutputChannel
): SemanticEnrichmentService {
  return new SemanticEnrichmentService(semanticIndex, {
    enabled: config.semanticEnrichment,
    concurrency: config.semanticConcurrency,
    timeoutMs: config.semanticTimeoutMs,
    providers: {
      getDefinitions,
      getDeclarations,
      getTypeDefinitions,
      getImplementations: getImplementationsAt,
      getReferences: getReferencesAt,
      getHoverSummary
    },
    onError: (message) => output.appendLine(message)
  });
}

function normalizeWorkspaceFilePath(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}
