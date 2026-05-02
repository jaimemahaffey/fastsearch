import * as vscode from 'vscode';
import { getDocumentSymbols } from './bridge/providerBridge';
import { findImplementations } from './commands/findImplementations';
import { findUsages } from './commands/findUsages';
import { goToFile } from './commands/goToFile';
import { rebuildIndex } from './commands/rebuildIndex';
import { goToSymbol } from './commands/goToSymbol';
import { goToText } from './commands/goToText';
import { readConfig, requiresRebuild } from './configuration';
import { IndexCoordinator } from './core/indexCoordinator';
import { PersistenceStore } from './core/persistenceStore';
import { shouldProcessUpdateJob, WORKSPACE_FILE_EXCLUDE_GLOB, type UpdateJob } from './core/workspaceWatcher';
import { FileIndex } from './indexes/fileIndex';
import { SymbolIndex } from './indexes/symbolIndex';
import { TextIndex } from './indexes/textIndex';
import { isEligibleTextFile } from './shared/fileEligibility';
import type { WorkspacePersistence } from './shared/types';

const INITIAL_INDEXES_WARMING_MESSAGE = 'Building initial indexes. Please wait a moment.';
const INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE = 'Initial index build is still running. Please wait for it to finish before rebuilding.';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Fast Symbol Indexer');
  const getConfig = () => readConfig();
  const config = getConfig();
  const fileIndex = new FileIndex();
  const symbolIndex = new SymbolIndex();
  const textIndex = new TextIndex();
  const persistenceStore = new PersistenceStore(context.globalStorageUri?.fsPath ?? context.storageUri?.fsPath ?? '.fast-indexer-cache');
  const workspacePersistence = getWorkspacePersistence();
  const buildWorkspace = async () => buildWorkspaceIndexes(fileIndex, symbolIndex, textIndex, getConfig().maxFileSizeKb, output);
  const coordinator = new IndexCoordinator({
    clearIndexes: () => {
      fileIndex.clear();
      symbolIndex.clear();
      textIndex.clear();
    },
    clearPersistence: async () => persistenceStore.clearWorkspaceCache(workspacePersistence.workspaceId),
    buildWorkspace
  });
  let initialFileIndexBuildPending = true;
  let rebuildQueued = false;
  let rebuildInFlight = false;
  let rebuildTimeout: NodeJS.Timeout | undefined;

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
    rebuildQueued = true;
    coordinator.markStale();

    if (rebuildTimeout) {
      clearTimeout(rebuildTimeout);
      rebuildTimeout = undefined;
    }

    runQueuedRebuild();
  };

  const queueWorkspaceRefreshForJob = (job: UpdateJob): void => {
    if (!shouldProcessUpdateJob(job)) {
      return;
    }

    queueWorkspaceRefresh();
  };

  coordinator.markWarming();
  const initialFileIndexBuild = buildWorkspace()
    .then(() => {
      coordinator.markReady();
    })
    .finally(() => {
      initialFileIndexBuildPending = false;
      if (rebuildQueued) {
        runQueuedRebuild();
      }
    });

  output.appendLine(`fastIndexer enabled=${config.enabled}`);

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    await initialFileIndexBuild;
    await goToFile(fileIndex);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToText', async () => {
    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    await initialFileIndexBuild;
    await goToText(textIndex);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToSymbol', async () => {
    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
    }

    await initialFileIndexBuild;
    await goToSymbol(symbolIndex);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.rebuildIndex', async () => {
    if (initialFileIndexBuildPending) {
      void vscode.window.showInformationMessage(INITIAL_INDEX_REBUILD_BLOCKED_MESSAGE);
      return;
    }

    await rebuildIndex(coordinator);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.findUsages', async () => {
    await findUsages(textIndex, symbolIndex, async () => {
      if (initialFileIndexBuildPending) {
        void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
      }

      await initialFileIndexBuild;
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.findImplementations', async () => {
    await findImplementations(symbolIndex, async () => {
      if (initialFileIndexBuildPending) {
        void vscode.window.showInformationMessage(INITIAL_INDEXES_WARMING_MESSAGE);
      }

      await initialFileIndexBuild;
    });
  }));

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'create',
        relativePath: vscode.workspace.asRelativePath(uri, true)
      });
    }),
    watcher.onDidChange((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'change',
        relativePath: vscode.workspace.asRelativePath(uri, true)
      });
    }),
    watcher.onDidDelete((uri) => {
      queueWorkspaceRefreshForJob({
        type: 'delete',
        relativePath: vscode.workspace.asRelativePath(uri, true)
      });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (requiresRebuild(event)) {
        queueWorkspaceRefresh();
      }
    })
  );

  context.subscriptions.push(output);
}

async function buildWorkspaceIndexes(
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  maxFileSizeKb: number,
  output: vscode.OutputChannel
): Promise<void> {
  try {
    const files = await vscode.workspace.findFiles('**/*', WORKSPACE_FILE_EXCLUDE_GLOB);

    for (const file of files) {
      const relativePath = vscode.workspace.asRelativePath(file, true);
      fileIndex.upsert(relativePath, file.toString(), toIndexedFileKey(file, relativePath));

      try {
        symbolIndex.replaceForFile(relativePath, await getDocumentSymbols(file));
      } catch (error) {
        output.appendLine(`Failed to read ${relativePath} for symbol indexing: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const content = await readEligibleTextContent(vscode.workspace.fs, file, relativePath, maxFileSizeKb);
        if (content !== undefined) {
          textIndex.upsert(relativePath, file.toString(), content);
        }
      } catch (error) {
        output.appendLine(`Failed to read ${relativePath} for text indexing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    output.appendLine(`Failed to build initial file index: ${error instanceof Error ? error.message : String(error)}`);
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
