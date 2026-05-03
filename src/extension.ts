import * as vscode from 'vscode';
import { getDocumentSymbols } from './bridge/providerBridge';
import { findImplementations } from './commands/findImplementations';
import { findUsages } from './commands/findUsages';
import { goToFile } from './commands/goToFile';
import { rebuildIndex } from './commands/rebuildIndex';
import { goToSymbol } from './commands/goToSymbol';
import { goToText } from './commands/goToText';
import { readConfig, requiresRebuild } from './configuration';
import { IndexCoordinator, shouldYield } from './core/indexCoordinator';
import { PersistenceStore } from './core/persistenceStore';
import { shouldProcessUpdateJob, WORKSPACE_FILE_EXCLUDE_GLOB, type UpdateJob, type WatcherPathFilters } from './core/workspaceWatcher';
import { FileIndex } from './indexes/fileIndex';
import { SymbolIndex } from './indexes/symbolIndex';
import { TextIndex } from './indexes/textIndex';
import { isEligibleTextFile } from './shared/fileEligibility';
import type { FastIndexerConfig } from './configuration';
import type { WorkspacePersistence } from './shared/types';

const INITIAL_INDEXES_WARMING_MESSAGE = 'Building initial indexes. Please wait a moment.';
const INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE = 'Initial index build is still running. Please wait for it to finish before rebuilding.';
const INDEXING_DISABLED_MESSAGE = 'Fast Symbol Indexer indexing is disabled.';
const INDEX_BUILD_YIELD_INTERVAL = 50;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Fast Symbol Indexer');
  const getConfig = () => readConfig();
  const config = getConfig();
  const fileIndex = new FileIndex();
  const symbolIndex = new SymbolIndex();
  const textIndex = new TextIndex();
  const persistenceStore = new PersistenceStore(context.globalStorageUri?.fsPath ?? context.storageUri?.fsPath ?? '.fast-indexer-cache');
  const workspacePersistence = getWorkspacePersistence();
  let buildGeneration = 0;
  const buildWorkspace = async () => {
    const generation = ++buildGeneration;
    return buildWorkspaceIndexes(fileIndex, symbolIndex, textIndex, getConfig(), output, () => getConfig().enabled && generation === buildGeneration);
  };
  const coordinator = new IndexCoordinator({
    clearIndexes: () => {
      fileIndex.clear();
      symbolIndex.clear();
      textIndex.clear();
    },
    clearPersistence: async () => persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId),
    buildWorkspace
  });
  let initialFileIndexBuildPending = config.enabled;
  let rebuildQueued = false;
  let rebuildInFlight = false;
  let rebuildTimeout: NodeJS.Timeout | undefined;
  let initialIndexPromise: Promise<void> = Promise.resolve();
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
    if (!shouldProcessUpdateJob(job, getWatcherFilters(getConfig()))) {
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
    beginBuildGate(buildWorkspace);
  };

  const startConfigRebuild = (): void => {
    if (rebuildTimeout) {
      clearTimeout(rebuildTimeout);
      rebuildTimeout = undefined;
    }

    rebuildQueued = false;
    buildGeneration += 1;
    coordinator.markStale();
    beginBuildGate(() => coordinator.rebuild());
  };

  const waitForCurrentBuild = async (): Promise<boolean> => {
    while (initialFileIndexBuildPending) {
      const token = initialBuildToken;
      await initialIndexPromise;
      if (token === initialBuildToken) {
        break;
      }
    }

    return getConfig().enabled;
  };

  if (config.enabled) {
    startInitialBuild();
  }

  if (!config.enabled) {
    coordinator.markStale();
    output.appendLine('Background indexing disabled by configuration.');
  }

  output.appendLine(`fastIndexer enabled=${config.enabled}`);

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    if (!await waitForCurrentBuild()) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToFile(fileIndex, getConfig());
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToText', async () => {
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    if (!await waitForCurrentBuild()) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToText(textIndex, getConfig());
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToSymbol', async () => {
    if (!getConfig().enabled) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    if (!await waitForCurrentBuild()) {
      void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
      return;
    }

    await goToSymbol(symbolIndex, getConfig());
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
        relativePath: vscode.workspace.asRelativePath(uri, false)
      });
    }),
    watcher.onDidChange((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'change',
        relativePath: vscode.workspace.asRelativePath(uri, false)
      });
    }),
    watcher.onDidDelete((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'delete',
        relativePath: vscode.workspace.asRelativePath(uri, false)
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
          buildGeneration += 1;
          rebuildQueued = false;
          rebuildInFlight = false;
          fileIndex.clear();
          symbolIndex.clear();
          textIndex.clear();
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

  context.subscriptions.push(output);
}

async function buildWorkspaceIndexes(
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  config: FastIndexerConfig,
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
      fileIndex.upsert(relativePath, file.toString(), toIndexedFileKey(file, relativePath));

      try {
        const symbols = await getDocumentSymbols(file);
        if (!shouldContinue()) {
          return false;
        }

        symbolIndex.replaceForFile(relativePath, symbols);
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

function toIndexedFileKey(file: vscode.Uri, relativePath: string): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
  if (!workspaceFolder) {
    return relativePath;
  }

  return `${workspaceFolder.uri.toString()}::${relativePath}`;
}

function getWorkspacePersistence(): WorkspacePersistence {
  const primaryWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return {
    workspaceId: primaryWorkspaceFolder ? encodeURIComponent(primaryWorkspaceFolder.uri.toString()) : 'workspace'
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

function getWatcherFilters(config: FastIndexerConfig): WatcherPathFilters {
  return {
    include: config.include,
    exclude: config.exclude
  };
}
