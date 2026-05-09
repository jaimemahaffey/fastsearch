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
import { createLayerAvailability, hasLayer, markLayerActive, markLayerAvailable, toPersistedLayerState } from './core/indexLayerState';
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
import type { IndexLayer, PersistedLayerState, WorkspacePersistence } from './shared/types';

const INITIAL_INDEXES_WARMING_MESSAGE = 'Building initial indexes. Please wait a moment.';
const INITIAL_FILE_LAYER_WARMING_MESSAGE = 'Building initial file index. Please wait a moment.';
const INITIAL_TEXT_LAYER_WARMING_MESSAGE = 'Building initial text index. Please wait a moment.';
const INITIAL_SYMBOL_LAYER_WARMING_MESSAGE = 'Building initial symbol index. Please wait a moment.';
const INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE = 'Initial index build is still running. Please wait for it to finish before rebuilding.';
const INDEXING_DISABLED_MESSAGE = 'Fast Symbol Indexer indexing is disabled.';
const INDEX_BUILD_YIELD_INTERVAL = 50;
const INDEX_BUILD_STATUS_PRIORITY = 100;
const PERSISTENCE_SCHEMA_VERSION = 2;

type IndexBuildKind = 'initial' | 'rebuild';

type IndexBuildProgress = {
  phase: 'discovering' | 'indexing';
  kind: IndexBuildKind;
  currentLayer?: IndexLayer;
  processedFiles: number;
  totalFiles?: number;
  skippedFiles: number;
  symbolTimeouts: number;
  currentFile?: string;
  startedAt: number;
};

type IndexBuildStatusReporter = {
  start: (token: number, kind: IndexBuildKind) => void;
  setTotalFiles: (token: number, totalFiles: number) => void;
  advance: (
    token: number,
    update: Pick<IndexBuildProgress, 'processedFiles' | 'skippedFiles' | 'symbolTimeouts' | 'currentFile' | 'currentLayer'>
  ) => void;
  finish: (token: number) => void;
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Fast Symbol Indexer');
  const buildStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, INDEX_BUILD_STATUS_PRIORITY);
  const buildStatus = createIndexBuildStatusReporter(buildStatusItem);
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
    const progressToken = activeBuildProgressToken;
    const buildKind = currentBuildKind;
    buildStatus.start(progressToken, buildKind);
    const generation = ++buildGeneration;

    try {
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
        () => getConfig().enabled && generation === buildGeneration,
        buildStatus,
        progressToken,
        async (layer, activeLayer) => {
          layerAvailability = markLayerAvailable(layerAvailability, layer);
          resolveLayerWaiters(layer);
          await persistLayerCheckpoint(activeLayer);
        }
      );

      if (completed !== false && getConfig().enabled) {
        await persistLayerCheckpoint();
      }

      return completed;
    } finally {
      buildStatus.finish(progressToken);
    }
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
  let blockingBuildInProgress = config.enabled;
  let rebuildQueued = false;
  let rebuildInFlight = false;
  let rebuildTimeout: NodeJS.Timeout | undefined;
  let initialIndexPromise: Promise<void> = Promise.resolve();
  let initialSnapshotRestorePending = false;
  let initialSnapshotPromise: Promise<void> = Promise.resolve();
  let restoredSnapshotReady = false;
  let initialBuildToken = 0;
  let activeBuildProgressToken = 0;
  let currentBuildKind: IndexBuildKind = 'initial';
  let layerAvailability = createLayerAvailability();
  const layerWaiters = new Map<IndexLayer, Array<() => void>>();

  const resolveLayerWaiters = (layer: IndexLayer): void => {
    const waiters = layerWaiters.get(layer) ?? [];
    layerWaiters.delete(layer);
    waiters.forEach((resolve) => resolve());
  };

  const resolveAllLayerWaiters = (): void => {
    for (const layer of layerWaiters.keys()) {
      resolveLayerWaiters(layer);
    }
  };

  const persistLayerCheckpoint = async (activeLayer?: IndexLayer): Promise<void> => {
    if (!getConfig().enabled) {
      return;
    }

    await persistenceStore.writeWorkspaceSnapshot(
      workspacePersistence.workspaceId,
      createPersistedWorkspaceSnapshot(
        workspacePersistence,
        activePersistenceConfigHash,
        fileIndex,
        symbolIndex,
        textIndex,
        semanticIndex,
        toPersistedLayerState(activeLayer ? markLayerActive(layerAvailability, activeLayer) : layerAvailability)
      )
    );
  };

  const runQueuedRebuild = (): void => {
    if (blockingBuildInProgress || rebuildInFlight) {
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
    activeBuildProgressToken = buildToken;
    blockingBuildInProgress = true;
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

        blockingBuildInProgress = false;
        resolveAllLayerWaiters();
        if (rebuildQueued) {
          runQueuedRebuild();
        }
      });
  };

  const startInitialBuild = (): void => {
    currentBuildKind = 'initial';
    coordinator.markWarming();
    restoredSnapshotReady = false;
    layerAvailability = createLayerAvailability();
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
      .then((snapshot) => {
        restoredSnapshotReady = snapshot !== undefined;
        const restoredLayerState = snapshot?.metadata.layerState;
        layerAvailability = restoredLayerState
          ? createLayerAvailability(restoredLayerState.availableLayers, restoredLayerState.activeLayer)
          : createLayerAvailability();
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
    currentBuildKind = 'rebuild';
    layerAvailability = createLayerAvailability();
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

    while (blockingBuildInProgress) {
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

  const waitForLayer = async (layer: IndexLayer, warmingMessage: string): Promise<boolean> => {
    await waitForInitialSnapshotRestore();

    if (hasLayer(layerAvailability, layer)) {
      return getConfig().enabled;
    }

    if (blockingBuildInProgress) {
      void vscode.window.showInformationMessage(warmingMessage);
    }

    while (!hasLayer(layerAvailability, layer) && blockingBuildInProgress) {
      await new Promise<void>((resolve) => {
        const waiters = layerWaiters.get(layer) ?? [];
        waiters.push(resolve);
        layerWaiters.set(layer, waiters);
      });
    }

    return getConfig().enabled && hasLayer(layerAvailability, layer);
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

    if (!await waitForLayer('symbol', INITIAL_SYMBOL_LAYER_WARMING_MESSAGE)) {
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

    if (!await waitForLayer('file', INITIAL_FILE_LAYER_WARMING_MESSAGE)) {
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

    if (!await waitForLayer('text', INITIAL_TEXT_LAYER_WARMING_MESSAGE)) {
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

    if (!await waitForLayer('symbol', INITIAL_SYMBOL_LAYER_WARMING_MESSAGE)) {
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

    if (blockingBuildInProgress) {
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
            if (blockingBuildInProgress) {
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
            if (blockingBuildInProgress) {
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
          blockingBuildInProgress = false;
          layerAvailability = createLayerAvailability();
          resolveAllLayerWaiters();
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
    buildStatusItem,
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
  shouldContinue: () => boolean,
  buildStatus: IndexBuildStatusReporter,
  progressToken: number,
  markLayerReady: (layer: IndexLayer, activeLayer?: IndexLayer) => Promise<void>
): Promise<boolean> {
  try {
    if (config.include.length === 0) {
      await markLayerReady('file', 'text');
      await markLayerReady('text', 'symbol');
      await markLayerReady('symbol');
      return true;
    }

    const files = await vscode.workspace.findFiles(
      toGlobExpression(config.include, '**/*'),
      toGlobExpression([WORKSPACE_FILE_EXCLUDE_GLOB, ...config.exclude], WORKSPACE_FILE_EXCLUDE_GLOB)
    );

    const candidates = files
      .map((file) => ({
        uri: file,
        relativePath: vscode.workspace.asRelativePath(file, true)
      }))
      .filter((candidate) => !ignoreMatcher.ignores(candidate.uri.fsPath, candidate.relativePath));

    const skippedFiles = files.length - candidates.length;
    let symbolTimeouts = 0;
    buildStatus.setTotalFiles(progressToken, files.length);
    buildStatus.advance(progressToken, {
      processedFiles: skippedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: undefined,
      currentLayer: 'file'
    });

    let filePhaseProcessed = skippedFiles;
    for (const candidate of candidates) {
      if (!shouldContinue()) {
        return false;
      }

      fileIndex.upsert(
        candidate.relativePath,
        candidate.uri.toString(),
        toIndexedFileKey(candidate.uri, candidate.relativePath)
      );

      filePhaseProcessed += 1;
      buildStatus.advance(progressToken, {
        processedFiles: filePhaseProcessed,
        skippedFiles,
        symbolTimeouts,
        currentFile: candidate.relativePath,
        currentLayer: 'file'
      });
      if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, filePhaseProcessed - skippedFiles)) {
        await yieldToEventLoop();
      }
    }

    await markLayerReady('file', 'text');
    buildStatus.advance(progressToken, {
      processedFiles: skippedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: undefined,
      currentLayer: 'text'
    });
    await yieldToEventLoop();

    let textPhaseProcessed = skippedFiles;
    for (const candidate of candidates) {
      try {
        const content = await readEligibleTextContent(vscode.workspace.fs, candidate.uri, candidate.relativePath, config.maxFileSizeKb);
        if (!shouldContinue()) {
          return false;
        }

        if (content !== undefined) {
          textIndex.upsert(candidate.relativePath, candidate.uri.toString(), content);
        }
      } catch (error) {
        output.appendLine(
          `Failed to read ${candidate.relativePath} for text indexing: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      textPhaseProcessed += 1;
      buildStatus.advance(progressToken, {
        processedFiles: textPhaseProcessed,
        skippedFiles,
        symbolTimeouts,
        currentFile: candidate.relativePath,
        currentLayer: 'text'
      });
      if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, textPhaseProcessed - skippedFiles)) {
        await yieldToEventLoop();
      }
    }

    await markLayerReady('text', 'symbol');
    buildStatus.advance(progressToken, {
      processedFiles: skippedFiles,
      skippedFiles,
      symbolTimeouts,
      currentFile: undefined,
      currentLayer: 'symbol'
    });

    let symbolPhaseProcessed = skippedFiles;
    for (const candidate of candidates) {
      const { uri, relativePath } = candidate;

      try {
        const symbolResult = await getDocumentSymbolsForBuild(uri, config.symbolProviderTimeoutMs);
        if (!shouldContinue()) {
          return false;
        }

        if (symbolResult.timedOut) {
          symbolTimeouts += 1;
          output.appendLine(
            `Timed out reading document symbols for ${relativePath} after ${config.symbolProviderTimeoutMs}ms; continuing without symbol results.`
          );
        } else {
          symbolIndex.replaceForFile(relativePath, symbolResult.symbols);
          semanticService.enqueueFile(relativePath, symbolResult.symbols, generation);
        }
      } catch (error) {
        output.appendLine(`Failed to read ${relativePath} for symbol indexing: ${error instanceof Error ? error.message : String(error)}`);
      }

      symbolPhaseProcessed += 1;
      buildStatus.advance(progressToken, {
        processedFiles: symbolPhaseProcessed,
        skippedFiles,
        symbolTimeouts,
        currentFile: relativePath,
        currentLayer: 'symbol'
      });
      if (shouldYield(INDEX_BUILD_YIELD_INTERVAL, symbolPhaseProcessed - skippedFiles)) {
        await yieldToEventLoop();
      }
    }

    await markLayerReady('symbol');

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
): Promise<PersistedWorkspaceSnapshot | undefined> {
  try {
    await refreshIgnoreMatcher();
    const snapshot = await persistenceStore.readWorkspaceSnapshot(workspacePersistence.workspaceId);
    if (!snapshot) {
      return undefined;
    }

    if (!isPersistedSnapshotValid(snapshot, workspacePersistence, getPersistenceConfigHash())) {
      await persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId);
      return undefined;
    }

    hydrateIndexesFromSnapshot(snapshot, fileIndex, symbolIndex, textIndex, semanticIndex);
    return snapshot;
  } catch (error) {
    await persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
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
  semanticIndex: SemanticIndex,
  layerState: PersistedLayerState
): PersistedWorkspaceSnapshot {
  return {
    metadata: {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      workspaceId: workspacePersistence.workspaceId,
      configHash: persistenceConfigHash,
      layerState
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
    semanticTimeoutMs: config.semanticTimeoutMs,
    symbolProviderTimeoutMs: config.symbolProviderTimeoutMs
  });
}

async function getDocumentSymbolsForBuild(
  file: vscode.Uri,
  timeoutMs: number
): Promise<
  | { timedOut: false; symbols: Awaited<ReturnType<typeof getDocumentSymbols>>; }
  | { timedOut: true; }
> {
  if (timeoutMs <= 0) {
    return {
      timedOut: false,
      symbols: await getDocumentSymbols(file)
    };
  }

  return raceWithTimeout(getDocumentSymbols(file), timeoutMs);
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<
  | { timedOut: false; symbols: T; }
  | { timedOut: true; }
> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, symbols: value });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createIndexBuildStatusReporter(statusItem: vscode.StatusBarItem): IndexBuildStatusReporter {
  let activeToken = 0;
  let state: IndexBuildProgress | undefined;

  const render = (): void => {
    if (!state) {
      return;
    }

    const action = state.kind === 'rebuild' ? 'rebuilding' : 'indexing';
    statusItem.text = state.phase === 'discovering'
      ? '$(sync~spin) Fast Indexer: scanning workspace...'
      : `$(sync~spin) Fast Indexer: ${action}${state.currentLayer ? ` ${state.currentLayer}` : ''} ${state.processedFiles}/${state.totalFiles ?? 0}`;
    statusItem.tooltip = createIndexBuildTooltip(state);
    statusItem.show();
  };

  return {
    start: (token, kind) => {
      activeToken = token;
      state = {
        phase: 'discovering',
        kind,
        processedFiles: 0,
        skippedFiles: 0,
        symbolTimeouts: 0,
        startedAt: Date.now()
      };
      render();
    },
    setTotalFiles: (token, totalFiles) => {
      if (token !== activeToken || !state) {
        return;
      }

      state = {
        ...state,
        phase: 'indexing',
        totalFiles
      };
      render();
    },
    advance: (token, update) => {
      if (token !== activeToken || !state) {
        return;
      }

      state = {
        ...state,
        phase: 'indexing',
        ...update
      };
      render();
    },
    finish: (token) => {
      if (token !== activeToken) {
        return;
      }

      activeToken = 0;
      state = undefined;
      statusItem.hide();
      statusItem.tooltip = undefined;
    }
  };
}

function createIndexBuildTooltip(state: IndexBuildProgress): string {
  const lines = [
    state.phase === 'discovering'
      ? 'Scanning workspace for files to index.'
      : `Processed ${state.processedFiles} of ${state.totalFiles ?? 0} files.`,
    `Skipped files: ${state.skippedFiles}`,
    `Symbol timeouts: ${state.symbolTimeouts}`,
    `Elapsed: ${Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))}s`
  ];

  if (state.currentFile) {
    lines.unshift(`Current file: ${state.currentFile}`);
  }

  if (state.currentLayer) {
    lines.unshift(`Layer: ${state.currentLayer}`);
  }

  return lines.join('\n');
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
