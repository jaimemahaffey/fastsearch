import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { IndexCoordinator } from '../../core/indexCoordinator';
import { PersistenceStore, type PersistedWorkspaceSnapshot } from '../../core/persistenceStore';
import { hashContent } from '../../core/contentHash';
import { buildMerkleTree } from '../../core/merkleTree';
import { toPersistedSubtreeHashes } from '../../core/merkleSnapshot';
import { FileIndex } from '../../indexes/fileIndex';
import { SymbolIndex } from '../../indexes/symbolIndex';
import { TextIndex } from '../../indexes/textIndex';
import { activate, readEligibleTextContent } from '../../extension';
import { FakeQuickPick } from './helpers/fakeQuickPick';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

function toPersistenceConfigHash(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    include: ['**/*'],
    exclude: ['**/node_modules/**', '**/.git/**'],
    ignoreFiles: [],
    sharedIgnoreFiles: [],
    ignoreInputs: [],
    maxFileSizeKb: 512,
    semanticEnrichment: true,
    semanticConcurrency: 2,
    semanticTimeoutMs: 750,
    symbolProviderTimeoutMs: 3000,
    ...overrides
  });
}

const DEFAULT_PERSISTENCE_CONFIG_HASH = toPersistenceConfigHash();

function toExpectedWorkspaceId(workspaceUris: vscode.Uri[]): string {
  const normalized = [...workspaceUris].map((uri) => uri.toString()).sort();
  if (normalized.length === 0) {
    return 'workspace';
  }

  if (normalized.length === 1) {
    return encodeURIComponent(normalized[0]!);
  }

  return encodeURIComponent(JSON.stringify(normalized));
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 5000
): Promise<void> {
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForAsync(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 5000
): Promise<void> {
  const startTime = Date.now();

  while (!await condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isCompleteLayerSnapshot(snapshot: PersistedWorkspaceSnapshot | undefined): boolean {
  if (!snapshot) {
    return false;
  }

  const layerState = snapshot.metadata.layerState;
  if (!layerState) {
    return true;
  }

  return layerState.activeLayer === undefined
    && layerState.availableLayers.includes('file')
    && layerState.availableLayers.includes('text')
    && layerState.availableLayers.includes('symbol');
}

function normalizeWorkspaceFsTestPath(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function createWorkspaceFsStub(fileContents: Record<string, string>): typeof vscode.workspace.fs {
  const originalFileSystem = vscode.workspace.fs;
  const fileMap = new Map<string, Uint8Array>(
    Object.entries(fileContents).map(([filePath, content]) => [
      normalizeWorkspaceFsTestPath(filePath),
      Buffer.from(content, 'utf8')
    ])
  );

  return {
    ...originalFileSystem,
    stat: async (uri: vscode.Uri) => {
      const bytes = fileMap.get(normalizeWorkspaceFsTestPath(uri.fsPath));
      if (bytes) {
        return {
          type: vscode.FileType.File,
          ctime: 0,
          mtime: 0,
          size: bytes.byteLength
        };
      }

      return originalFileSystem.stat(uri);
    },
    readFile: async (uri: vscode.Uri) => {
      const bytes = fileMap.get(normalizeWorkspaceFsTestPath(uri.fsPath));
      if (bytes) {
        return bytes;
      }

      return originalFileSystem.readFile(uri);
    }
  };
}

function createTrackedStatusBarItem(
  textUpdates: string[],
  visibilityEvents: string[]
): vscode.StatusBarItem {
  let text = '';
  let tooltip: vscode.MarkdownString | string | undefined;
  const item: Partial<vscode.StatusBarItem> = {
    name: 'Fast Symbol Indexer Progress',
    show: () => {
      visibilityEvents.push('show');
    },
    hide: () => {
      visibilityEvents.push('hide');
    },
    dispose: () => undefined
  };

  Object.defineProperty(item, 'text', {
    configurable: true,
    enumerable: true,
    get: () => text,
    set: (value: string) => {
      text = value;
      textUpdates.push(value);
    }
  });
  Object.defineProperty(item, 'tooltip', {
    configurable: true,
    enumerable: true,
    get: () => tooltip,
    set: (value: vscode.MarkdownString | string | undefined) => {
      tooltip = value;
    }
  });

  return item as vscode.StatusBarItem;
}

function createSnapshotFileRecord(relativePath: string, uri: vscode.Uri): PersistedWorkspaceSnapshot['fileIndex'][number] {
  return {
    relativePath,
    uri: uri.toString(),
    basename: path.basename(relativePath),
    extension: path.extname(relativePath),
    tokens: relativePath.toLowerCase().split(/[\\/._-]+/)
  };
}

function createPersistedSnapshot(
  workspaceUri: vscode.Uri,
  entries: Array<{
    relativePath: string;
    content: string;
    symbolName: string;
    symbolContentHash: string | null;
  }>,
  configHash = DEFAULT_PERSISTENCE_CONFIG_HASH,
  layerState?: PersistedWorkspaceSnapshot['metadata']['layerState']
): PersistedWorkspaceSnapshot {
  const fileIndex = entries.map((entry) => createSnapshotFileRecord(entry.relativePath, vscode.Uri.joinPath(workspaceUri, ...entry.relativePath.split('/'))));
  const leaves = entries.map((entry) => ({
    relativePath: entry.relativePath,
    uri: vscode.Uri.joinPath(workspaceUri, ...entry.relativePath.split('/')).toString(),
    contentHash: hashContent(entry.content),
    size: Buffer.byteLength(entry.content, 'utf8')
  }));
  const merkle = buildMerkleTree(leaves);

  return {
    metadata: {
      schemaVersion: 2,
      workspaceId: toExpectedWorkspaceId([workspaceUri]),
      configHash,
      ...(layerState ? { layerState } : {})
    },
    merkle: {
      rootHash: merkle.rootHash,
      subtreeHashes: toPersistedSubtreeHashes(merkle.subtreeHashes),
      leaves: [...merkle.leavesByPath.values()]
    },
    fileIndex,
    textIndex: entries.map((entry) => ({
      relativePath: entry.relativePath,
      uri: vscode.Uri.joinPath(workspaceUri, ...entry.relativePath.split('/')).toString(),
      content: entry.content,
      contentHash: hashContent(entry.content)
    })),
    symbolIndex: entries.map((entry) => ({
      relativePath: entry.relativePath,
      contentHash: entry.symbolContentHash,
      symbols: [{
        name: entry.symbolName,
        kind: 5,
        uri: vscode.Uri.joinPath(workspaceUri, ...entry.relativePath.split('/')).toString(),
        startLine: 0,
        startColumn: 0,
        approximate: false
      }]
    }))
  };
}

suite('extension activation', () => {
  test('reuses cached file, text, and symbol entries when the persisted Merkle leaf hash is unchanged', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-unchanged-'));
    const unchangedFilePath = path.join(workspaceRoot, 'src', 'app', 'unchanged.ts');
    const stableFilePath = path.join(workspaceRoot, 'src', 'app', 'stable.ts');
    await fs.mkdir(path.dirname(unchangedFilePath), { recursive: true });
    await fs.writeFile(unchangedFilePath, 'export const unchanged = 1;\n', 'utf8');
    await fs.writeFile(stableFilePath, 'export const stable = 2;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const unchangedUri = vscode.Uri.file(unchangedFilePath);
    const stableUri = vscode.Uri.file(stableFilePath);
    const persistedSnapshot = createPersistedSnapshot(workspaceUri, [
      {
        relativePath: 'src/app/unchanged.ts',
        content: 'export const unchanged = 1;\n',
        symbolName: 'UnchangedService',
        symbolContentHash: hashContent('export const unchanged = 1;\n')
      },
      {
        relativePath: 'src/app/stable.ts',
        content: 'export const stable = 2;\n',
        symbolName: 'StableService',
        symbolContentHash: hashContent('export const stable = 2;\n')
      }
    ], toPersistenceConfigHash({ semanticEnrichment: false }));
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const buildPhaseFileUpserts: string[] = [];
    const buildPhaseTextUpserts: string[] = [];
    const buildPhaseSymbolReplacements: string[] = [];
    let buildStarted = false;
    let resolvedPersistence = false;
    const originalFileUpsert = FileIndex.prototype.upsert;
    const originalTextUpsert = TextIndex.prototype.upsert;
    const originalSymbolReplaceForFile = SymbolIndex.prototype.replaceForFile;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'Symbol',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 6),
          new vscode.Range(0, 0, 0, 6)
        )];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => {
      buildStarted = true;
      return [unchangedUri, stableUri];
    }) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string'
        ? pathOrUri
        : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.fsPath.startsWith(workspaceRoot) ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const fileUpsertPatch = patchProperty(FileIndex.prototype, 'upsert', function (this: FileIndex, relativePath: string, uri: string, key = relativePath) {
      if (buildStarted) {
        buildPhaseFileUpserts.push(relativePath);
      }

      return originalFileUpsert.call(this, relativePath, uri, key);
    } as typeof FileIndex.prototype.upsert);
    const textUpsertPatch = patchProperty(TextIndex.prototype, 'upsert', function (this: TextIndex, relativePath: string, uri: string, content: string) {
      if (buildStarted) {
        buildPhaseTextUpserts.push(relativePath);
      }

      return originalTextUpsert.call(this, relativePath, uri, content);
    } as typeof TextIndex.prototype.upsert);
    const symbolReplacePatch = patchProperty(SymbolIndex.prototype, 'replaceForFile', function (this: SymbolIndex, relativePath: string, symbols) {
      if (buildStarted) {
        buildPhaseSymbolReplacements.push(relativePath);
      }

      return originalSymbolReplaceForFile.call(this, relativePath, symbols);
    } as typeof SymbolIndex.prototype.replaceForFile);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => {
        resolvedPersistence = true;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => resolvedPersistence, 'persisted snapshot after unchanged reconciliation');

      assert.deepEqual(buildPhaseFileUpserts, []);
      assert.deepEqual(buildPhaseTextUpserts, []);
      assert.deepEqual(buildPhaseSymbolReplacements, []);
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(symbolReplacePatch);
      restoreProperty(textUpsertPatch);
      restoreProperty(fileUpsertPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('rebuilds only changed files when one persisted Merkle leaf hash differs', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-changed-'));
    const unchangedFilePath = path.join(workspaceRoot, 'src', 'app', 'unchanged.ts');
    const changedFilePath = path.join(workspaceRoot, 'src', 'app', 'changed.ts');
    await fs.mkdir(path.dirname(unchangedFilePath), { recursive: true });
    await fs.writeFile(unchangedFilePath, 'export const unchanged = 1;\n', 'utf8');
    await fs.writeFile(changedFilePath, 'export const changed = 2;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const unchangedUri = vscode.Uri.file(unchangedFilePath);
    const changedUri = vscode.Uri.file(changedFilePath);
    const persistedSnapshot = createPersistedSnapshot(workspaceUri, [
      {
        relativePath: 'src/app/unchanged.ts',
        content: 'export const unchanged = 1;\n',
        symbolName: 'UnchangedService',
        symbolContentHash: hashContent('export const unchanged = 1;\n')
      },
      {
        relativePath: 'src/app/changed.ts',
        content: 'export const changed = 1;\n',
        symbolName: 'ChangedService',
        symbolContentHash: hashContent('export const changed = 1;\n')
      }
    ], toPersistenceConfigHash({ semanticEnrichment: false }));
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const buildPhaseFileUpserts: string[] = [];
    const buildPhaseTextUpserts: string[] = [];
    const buildPhaseSymbolReplacements: string[] = [];
    let buildStarted = false;
    let resolvedPersistence = false;
    const originalFileUpsert = FileIndex.prototype.upsert;
    const originalTextUpsert = TextIndex.prototype.upsert;
    const originalSymbolReplaceForFile = SymbolIndex.prototype.replaceForFile;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'Symbol',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 6),
          new vscode.Range(0, 0, 0, 6)
        )];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => {
      buildStarted = true;
      return [unchangedUri, changedUri];
    }) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string'
        ? pathOrUri
        : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.fsPath.startsWith(workspaceRoot) ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const fileUpsertPatch = patchProperty(FileIndex.prototype, 'upsert', function (this: FileIndex, relativePath: string, uri: string, key = relativePath) {
      if (buildStarted) {
        buildPhaseFileUpserts.push(relativePath);
      }

      return originalFileUpsert.call(this, relativePath, uri, key);
    } as typeof FileIndex.prototype.upsert);
    const textUpsertPatch = patchProperty(TextIndex.prototype, 'upsert', function (this: TextIndex, relativePath: string, uri: string, content: string) {
      if (buildStarted) {
        buildPhaseTextUpserts.push(relativePath);
      }

      return originalTextUpsert.call(this, relativePath, uri, content);
    } as typeof TextIndex.prototype.upsert);
    const symbolReplacePatch = patchProperty(SymbolIndex.prototype, 'replaceForFile', function (this: SymbolIndex, relativePath: string, symbols) {
      if (buildStarted) {
        buildPhaseSymbolReplacements.push(relativePath);
      }

      return originalSymbolReplaceForFile.call(this, relativePath, symbols);
    } as typeof SymbolIndex.prototype.replaceForFile);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => {
        resolvedPersistence = true;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => resolvedPersistence, 'persisted snapshot after selective reconciliation');

      assert.deepEqual(buildPhaseFileUpserts, ['src/app/changed.ts']);
      assert.deepEqual(buildPhaseTextUpserts, ['src/app/changed.ts']);
      assert.deepEqual(buildPhaseSymbolReplacements, ['src/app/changed.ts']);
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(symbolReplacePatch);
      restoreProperty(textUpsertPatch);
      restoreProperty(fileUpsertPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('records symbolComplete only after the current activation reaches symbol hydration completion', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-benchmark-symbol-complete-'));
    const unchangedFilePath = path.join(workspaceRoot, 'src', 'app', 'stable.ts');
    const benchmarkPath = path.join(workspaceRoot, 'benchmark', 'events.json');
    await fs.mkdir(path.dirname(unchangedFilePath), { recursive: true });
    await fs.writeFile(unchangedFilePath, 'export const stable = 2;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const unchangedUri = vscode.Uri.file(unchangedFilePath);
    const persistedSnapshot = createPersistedSnapshot(
      workspaceUri,
      [{
        relativePath: 'src/app/stable.ts',
        content: 'export const stable = 2;\n',
        symbolName: 'StableService',
        symbolContentHash: hashContent('export const stable = 2;\n')
      }],
      toPersistenceConfigHash({ semanticEnrichment: false }),
      {
        availableLayers: ['file', 'text', 'symbol'],
        activeLayer: undefined
      }
    );
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let persistedWrites = 0;
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;
    const originalBenchmarkPath = process.env.FASTSEARCH_BENCHMARK_PATH;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => new Promise<vscode.Uri[]>((resolve) => {
      resolveFindFiles = resolve;
    })) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string'
        ? pathOrUri
        : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.fsPath.startsWith(workspaceRoot) ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => {
        persistedWrites += 1;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    process.env.FASTSEARCH_BENCHMARK_PATH = benchmarkPath;

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitForAsync(async () => {
        try {
          const recorded = JSON.parse(await fs.readFile(benchmarkPath, 'utf8')) as { events: Array<{ event: string }> };
          return recorded.events.some((event) => event.event === 'symbolUsable');
        } catch {
          return false;
        }
      }, 'restored benchmark events');

      const initialEvents = JSON.parse(await fs.readFile(benchmarkPath, 'utf8')) as { events: Array<{ event: string }> };
      assert.deepEqual(
        initialEvents.events.map((event) => event.event),
        ['fileReady', 'textReady', 'symbolUsable']
      );

      resolveFindFiles?.([unchangedUri]);

      await waitForAsync(async () => {
        try {
          const recorded = JSON.parse(await fs.readFile(benchmarkPath, 'utf8')) as { events: Array<{ event: string }> };
          return recorded.events.some((event) => event.event === 'symbolComplete');
        } catch {
          return false;
        }
      }, 'symbolComplete benchmark event after reconciliation');
      await waitFor(() => persistedWrites >= 1, 'persisted snapshot after unchanged reconciliation');

      const completedEvents = JSON.parse(await fs.readFile(benchmarkPath, 'utf8')) as { events: Array<{ event: string }> };
      assert.equal(completedEvents.events.filter((event) => event.event === 'symbolComplete').length, 1);
    } finally {
      if (originalBenchmarkPath === undefined) {
        delete process.env.FASTSEARCH_BENCHMARK_PATH;
      } else {
        process.env.FASTSEARCH_BENCHMARK_PATH = originalBenchmarkPath;
      }
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('restores a persisted snapshot so go to file is usable before reconciliation finishes', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const persistedSnapshot = {
      metadata: {
        schemaVersion: 2,
        workspaceId: toExpectedWorkspaceId([workspaceUri]),
        configHash: DEFAULT_PERSISTENCE_CONFIG_HASH
              },
        merkle: {
          rootHash: '',
          subtreeHashes: [],
          leaves: []
        },
        fileIndex: [{
        relativePath: 'src/app/main.ts',
        uri: 'file:///workspace/src/app/main.ts',
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['src', 'app', 'main', 'ts']
      }],
      textIndex: [],
      symbolIndex: []
    };
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = resolve;
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'main') as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );

    const goToFileCommandPromise = (async () => {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      await Promise.resolve(goToFileCommand?.());
    })();

    try {
      const outcome = await Promise.race([
        goToFileCommandPromise.then(() => 'resolved'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50))
      ]);

      assert.equal(outcome, 'resolved');
      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'main.ts');
    } finally {
      resolveFindFiles?.([]);
      await goToFileCommandPromise;
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('go to file is usable after the file layer completes while text and symbol work continue', async () => {
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const files = [
      vscode.Uri.parse('file:///workspace/src/alpha.ts'),
      vscode.Uri.parse('file:///workspace/src/beta.ts')
    ];
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const infoMessages: string[] = [];
    const quickPicks: Array<FakeQuickPick<vscode.QuickPickItem & { description?: string; }>> = [];
    let releaseTextLayer: (() => void) | undefined;
    let symbolRelease: (() => void) | undefined;
    const textLayerReady = new Promise<void>((resolve) => {
      releaseTextLayer = resolve;
    });
    const symbolLayerReady = new Promise<void>((resolve) => {
      symbolRelease = resolve;
    });
    const originalWorkspaceFs = vscode.workspace.fs;

    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => registeredCommands.delete(command));
    }) as typeof vscode.commands.registerCommand);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessages.push(message);
      return message;
    }) as typeof vscode.window.showInformationMessage);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: true,
            useRipgrep: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((value: string | vscode.Uri) =>
      typeof value === 'string' ? value : value.path.replace('/workspace/', '')
    ) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', (((_uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as unknown) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const quickPickPatch = patchProperty(vscode.window, 'createQuickPick', ((() => {
      const quickPick = new FakeQuickPick<vscode.QuickPickItem & { description?: string; }>();
      quickPicks.push(quickPick);
      return quickPick;
    }) as unknown) as typeof vscode.window.createQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const fsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      stat: async () => ({
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: 64
      }),
      readFile: async () => {
        await textLayerReady;
        return Uint8Array.from(Buffer.from('export const value = 1;'));
      }
    } as typeof vscode.workspace.fs);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        await symbolLayerReady;
        return [];
      }
      return [];
    }) as typeof vscode.commands.executeCommand);

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => registeredCommands.has('fastIndexer.goToFile'), 'goToFile command registration');
      await waitFor(() => registeredCommands.has('fastIndexer.goToText'), 'goToText command registration');

      const goToFilePromise = Promise.resolve(registeredCommands.get('fastIndexer.goToFile')?.());
      await goToFilePromise;
      assert.equal(quickPicks.length, 1);
      assert.equal(quickPicks[0]?.showed, true);
      assert.deepEqual(quickPicks[0]?.items.map((item) => item.description), ['src/alpha.ts', 'src/beta.ts']);

      const goToTextPromise = Promise.resolve(registeredCommands.get('fastIndexer.goToText')?.());
      const goToTextOutcome = await Promise.race([
        goToTextPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20))
      ]);
      assert.equal(goToTextOutcome, 'waiting');
      assert.equal(quickPicks.length, 1);

      assert.equal(infoMessages.includes('Building initial text index. Please wait a moment.'), true);

      releaseTextLayer?.();
      await goToTextPromise;
      assert.equal(quickPicks.length, 2);
    } finally {
      releaseTextLayer?.();
      symbolRelease?.();
      restoreProperty(executePatch);
      restoreProperty(fsPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(infoPatch);
      restoreProperty(registerPatch);
    }
  });

  test('go to text is usable after the initial text hydration batch while later text work continues', async () => {
    const workspaceRoot = 'c:\\workspace';
    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const expectedTextHydrationBatchSize = 100;
    const fileCount = 1000;
    const files = Array.from({ length: fileCount }, (_, index) =>
      vscode.Uri.file(path.join(workspaceRoot, 'src', `batch-${String(index).padStart(4, '0')}.ts`))
    );
    const fileContents = Object.fromEntries(
      files.map((file, index) => [
        file.fsPath,
        `export const batch${index} = "hydrationNeedle ${index}";\n`
      ])
    );
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPicks: Array<FakeQuickPick<vscode.QuickPickItem & { description?: string; }>> = [];
    const originalTextUpsert = TextIndex.prototype.upsert;
    let textUpsertCount = 0;
    let goToTextPromise: Promise<unknown> | undefined;
    let releaseCommandStarted: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      releaseCommandStarted = resolve;
    });
    let releaseReadyTextCheckpoint: (() => void) | undefined;
    let readyTextCheckpointBlocked = false;
    let readyTextCheckpointWrites = 0;
    const readyTextCheckpointEntryCounts: number[] = [];
    let completedSnapshotWritten = false;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => registeredCommands.delete(command));
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: true,
            useRipgrep: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string'
        ? pathOrUri
        : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', (((_uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as unknown) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const quickPickPatch = patchProperty(vscode.window, 'createQuickPick', ((() => {
      const quickPick = new FakeQuickPick<vscode.QuickPickItem & { description?: string; }>();
      quickPicks.push(quickPick);
      return quickPick;
    }) as unknown) as typeof vscode.window.createQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        const layerState = snapshot.metadata.layerState;
        if (
          layerState?.activeLayer === 'text'
          && layerState.availableLayers.includes('text')
          && !isCompleteLayerSnapshot(snapshot)
        ) {
          readyTextCheckpointWrites += 1;
          readyTextCheckpointEntryCounts.push(snapshot.textIndex.length);
          if (!readyTextCheckpointBlocked) {
            readyTextCheckpointBlocked = true;
            assert.ok(
              snapshot.textIndex.length >= expectedTextHydrationBatchSize,
              `expected ready text checkpoint to contain at least ${expectedTextHydrationBatchSize} text entries, found ${snapshot.textIndex.length}`
            );
            return await new Promise<void>((resolve) => {
              releaseReadyTextCheckpoint = resolve;
            });
          }
        }

        if (isCompleteLayerSnapshot(snapshot)) {
          completedSnapshotWritten = true;
        }
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const fsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub(fileContents));
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const textUpsertPatch = patchProperty(TextIndex.prototype, 'upsert', function (this: TextIndex, relativePath: string, uri: string, content: string) {
      textUpsertCount += 1;
      const result = originalTextUpsert.call(this, relativePath, uri, content);
      if (textUpsertCount === expectedTextHydrationBatchSize && !goToTextPromise) {
        goToTextPromise = Promise.resolve(registeredCommands.get('fastIndexer.goToText')?.());
        releaseCommandStarted?.();
      }
      return result;
    } as typeof TextIndex.prototype.upsert);

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => registeredCommands.has('fastIndexer.goToText'), 'goToText command registration');
      await commandStarted;
      await goToTextPromise;

      assert.equal(readyTextCheckpointBlocked, true);
      assert.equal(readyTextCheckpointWrites, 1);
      assert.deepEqual(readyTextCheckpointEntryCounts, [expectedTextHydrationBatchSize]);
      assert.equal(completedSnapshotWritten, false);
      assert.ok(textUpsertCount < fileCount, `expected text command before all files hydrated, processed ${textUpsertCount}`);
      assert.equal(quickPicks.length, 1);
      assert.equal(quickPicks[0]?.showed, true);

      const itemsUpdated = quickPicks[0]!.waitForItemsUpdate();
      quickPicks[0]!.fireChangeValue('hydrationNeedle');
      await itemsUpdated;
      assert.ok(quickPicks[0]!.items.length > 0);

      releaseReadyTextCheckpoint?.();
      await waitFor(() => completedSnapshotWritten, 'final complete snapshot persistence');
      assert.equal(readyTextCheckpointWrites, 1);
    } finally {
      releaseReadyTextCheckpoint?.();
      restoreProperty(textUpsertPatch);
      restoreProperty(executePatch);
      restoreProperty(fsPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('skips early text checkpoint persistence when the build generation changes at the persistence boundary', async () => {
    const workspaceRoot = 'c:\\workspace';
    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const file = vscode.Uri.file(path.join(workspaceRoot, 'src', 'alpha.ts'));
    const fileContent = 'export const alpha = "generation-race";\n';
    const originalWorkspaceFs = vscode.workspace.fs;
    let indexingEnabled = true;
    let configurationListener: ((event: vscode.ConfigurationChangeEvent) => unknown) | undefined;
    let merkleReadComplete = false;
    let enabledChecksAfterMerkleRead = 0;
    let raceTriggered = false;
    let staleEarlyTextWrites = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [file]) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          if (key === 'enabled') {
            if (merkleReadComplete) {
              enabledChecksAfterMerkleRead += 1;
            }

            // With one file, the third enabled check after Merkle read completion is the
            // early text checkpoint boundary: post-read, final Merkle check, checkpoint.
            if (enabledChecksAfterMerkleRead === 3 && !raceTriggered) {
              raceTriggered = true;
              indexingEnabled = false;
              configurationListener?.({
                affectsConfiguration: (name: string) => name === 'fastIndexer.enabled'
              } as vscode.ConfigurationChangeEvent);
              return true as T;
            }

            return indexingEnabled as T;
          }

          const values: Record<string, unknown> = {
            completionStyleResults: false,
            useRipgrep: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) =>
      typeof pathOrUri === 'string'
        ? pathOrUri
        : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/')
    ) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', (((_uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as unknown) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      configurationListener = listener;
      return new vscode.Disposable(() => {
        configurationListener = undefined;
      });
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (raceTriggered && snapshot.metadata.layerState?.activeLayer === 'text') {
          staleEarlyTextWrites += 1;
        }
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const fsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      stat: async () => ({
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: Buffer.byteLength(fileContent, 'utf8')
      }),
      readFile: async () => {
        merkleReadComplete = true;
        return Uint8Array.from(Buffer.from(fileContent));
      }
    } as typeof vscode.workspace.fs);

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => raceTriggered, 'generation change during early text checkpoint');
      await waitFor(() => enabledChecksAfterMerkleRead > 3, 'cancelled early text build to observe cancellation');

      assert.equal(staleEarlyTextWrites, 0, 'stale early text checkpoint should not write after generation changes');
    } finally {
      restoreProperty(fsPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executePatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('marks the initial build ready before all provider-backed symbol hydration completes', async () => {
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const files = [
      vscode.Uri.parse('file:///workspace/src/alpha.ts'),
      vscode.Uri.parse('file:///workspace/src/beta.ts'),
      vscode.Uri.parse('file:///workspace/src/gamma.ts')
    ];
    const expectedWorkspaceId = encodeURIComponent(workspaceUri.toString());
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const originalWorkspaceFs = vscode.workspace.fs;
    let symbolProviderCalls = 0;
    let completeSnapshotPersisted = false;
    let resolveCompleteSnapshot: (() => void) | undefined;
    let releaseSymbolProviders: (() => void) | undefined;
    const completeSnapshotPromise = new Promise<void>((resolve) => {
      resolveCompleteSnapshot = resolve;
    });
    const symbolProvidersReleased = new Promise<void>((resolve) => {
      releaseSymbolProviders = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => registeredCommands.delete(command));
    }) as typeof vscode.commands.registerCommand);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        symbolProviderCalls += 1;
        await symbolProvidersReleased;
        return [new vscode.DocumentSymbol(
          'DelayedSymbol',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 13),
          new vscode.Range(0, 0, 0, 13)
        )];
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            useRipgrep: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) =>
      typeof pathOrUri === 'string'
        ? pathOrUri
        : pathOrUri.path.replace('/workspace/', '')
    ) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', (((_uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as unknown) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (workspaceId !== expectedWorkspaceId || completeSnapshotPersisted || !isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        completeSnapshotPersisted = true;
        resolveCompleteSnapshot?.();
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const fsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      stat: async () => ({
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: Buffer.byteLength('export const value = 1;', 'utf8')
      }),
      readFile: async () => Uint8Array.from(Buffer.from('export const value = 1;'))
    } as typeof vscode.workspace.fs);

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => registeredCommands.has('fastIndexer.goToText'), 'goToText command registration');

      const outcome = await Promise.race([
        completeSnapshotPromise.then(() => 'persisted'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100))
      ]);

      assert.equal(outcome, 'persisted');
      assert.equal(symbolProviderCalls < files.length, true);
    } finally {
      releaseSymbolProviders?.();
      await waitFor(() => symbolProviderCalls === files.length, 'symbol provider calls to drain');
      restoreProperty(fsPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executePatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('skips scheduler checkpoint persistence when the build generation changes at the persistence boundary', async () => {
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const files = [
      vscode.Uri.parse('file:///workspace/src/alpha.ts'),
      vscode.Uri.parse('file:///workspace/src/beta.ts'),
      vscode.Uri.parse('file:///workspace/src/gamma.ts')
    ];
    const originalWorkspaceFs = vscode.workspace.fs;
    const originalSymbolReplaceForFile = SymbolIndex.prototype.replaceForFile;
    let indexingEnabled = true;
    let completeSnapshotPersisted = false;
    let releaseSymbolProviders: (() => void) | undefined;
    let configurationListener: ((event: vscode.ConfigurationChangeEvent) => unknown) | undefined;
    let hydratedSymbolReplacements = 0;
    let armGenerationRace = false;
    let raceTriggered = false;
    let staleSchedulerWrites = 0;
    const symbolProvidersReleased = new Promise<void>((resolve) => {
      releaseSymbolProviders = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        await symbolProvidersReleased;
        return [new vscode.DocumentSymbol(
          'HydratedSymbol',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 14),
          new vscode.Range(0, 0, 0, 14)
        )];
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          if (key === 'enabled') {
            if (armGenerationRace && !raceTriggered) {
              raceTriggered = true;
              indexingEnabled = false;
              configurationListener?.({
                affectsConfiguration: (name: string) => name === 'fastIndexer.enabled'
              } as vscode.ConfigurationChangeEvent);
              return true as T;
            }

            return indexingEnabled as T;
          }

          const values: Record<string, unknown> = {
            completionStyleResults: false,
            useRipgrep: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) =>
      typeof pathOrUri === 'string'
        ? pathOrUri
        : pathOrUri.path.replace('/workspace/', '')
    ) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', (((_uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as unknown) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      configurationListener = listener;
      return new vscode.Disposable(() => {
        configurationListener = undefined;
      });
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (raceTriggered) {
          staleSchedulerWrites += 1;
          return;
        }

        if (isCompleteLayerSnapshot(snapshot)) {
          completeSnapshotPersisted = true;
        }
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const fsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      stat: async () => ({
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: Buffer.byteLength('export const value = 1;', 'utf8')
      }),
      readFile: async () => Uint8Array.from(Buffer.from('export const value = 1;'))
    } as typeof vscode.workspace.fs);
    const symbolReplacePatch = patchProperty(SymbolIndex.prototype, 'replaceForFile', function (this: SymbolIndex, relativePath, symbols) {
      const result = originalSymbolReplaceForFile.call(this, relativePath, symbols);
      hydratedSymbolReplacements += 1;
      if (hydratedSymbolReplacements === files.length) {
        armGenerationRace = true;
      }
      return result;
    } as typeof SymbolIndex.prototype.replaceForFile);

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => completeSnapshotPersisted, 'initial complete snapshot persistence');

      releaseSymbolProviders?.();
      await waitFor(() => raceTriggered, 'generation change during scheduler checkpoint');

      assert.equal(staleSchedulerWrites, 0, 'stale scheduler checkpoint should not write after generation changes');
    } finally {
      releaseSymbolProviders?.();
      restoreProperty(symbolReplacePatch);
      restoreProperty(fsPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executePatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('does not persist restored symbols for changed files before background hydration completes', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-deferred-stale-symbols-'));
    const changedFilePath = path.join(workspaceRoot, 'src', 'app', 'changed.ts');
    await fs.mkdir(path.dirname(changedFilePath), { recursive: true });
    await fs.writeFile(changedFilePath, 'export const changed = 2;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const changedUri = vscode.Uri.file(changedFilePath);
    const persistedSnapshot = createPersistedSnapshot(workspaceUri, [
      {
        relativePath: 'src/app/changed.ts',
        content: 'export const changed = 1;\n',
        symbolName: 'OldChangedService',
        symbolContentHash: hashContent('export const changed = 1;\n')
      }
    ], toPersistenceConfigHash({ semanticEnrichment: false }));
    const expectedWorkspaceId = encodeURIComponent(workspaceUri.toString());
    let activeSymbolSnapshot: PersistedWorkspaceSnapshot | undefined;
    let resolveActiveSymbolSnapshot: (() => void) | undefined;
    let releaseSymbolProvider: (() => void) | undefined;
    const activeSymbolSnapshotPromise = new Promise<void>((resolve) => {
      resolveActiveSymbolSnapshot = resolve;
    });
    const symbolProviderReleased = new Promise<void>((resolve) => {
      releaseSymbolProvider = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        await symbolProviderReleased;
        return [new vscode.DocumentSymbol(
          'NewChangedService',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 17),
          new vscode.Range(0, 0, 0, 17)
        )];
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [changedUri]) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            useRipgrep: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) =>
      typeof pathOrUri === 'string'
        ? pathOrUri
        : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/')
    ) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.fsPath.startsWith(workspaceRoot) ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (
          workspaceId !== expectedWorkspaceId
          || activeSymbolSnapshot
          || snapshot.metadata.layerState?.activeLayer !== 'symbol'
        ) {
          return;
        }

        activeSymbolSnapshot = snapshot;
        resolveActiveSymbolSnapshot?.();
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

      const outcome = await Promise.race([
        activeSymbolSnapshotPromise.then(() => 'persisted'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 500))
      ]);

      assert.equal(outcome, 'persisted');
      assert.deepEqual(activeSymbolSnapshot?.symbolIndex.map((entry) => entry.relativePath), []);
    } finally {
      releaseSymbolProvider?.();
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executePatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('restores a file-only snapshot and marks symbol search usable before hydration completes', async () => {
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const indexedFile = vscode.Uri.parse('file:///workspace/src/app/main.ts');
    const indexedContent = 'export const value = 1;';
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const infoMessages: string[] = [];
    const originalWorkspaceFs = vscode.workspace.fs;
    let releaseSymbolLayer: (() => void) | undefined;
    const symbolLayerReady = new Promise<void>((resolve) => {
      releaseSymbolLayer = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => registeredCommands.delete(command));
    }) as typeof vscode.commands.registerCommand);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessages.push(message);
      return message;
    }) as typeof vscode.window.showInformationMessage);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        await symbolLayerReady;
        return [];
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            useRipgrep: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'main') as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async () => undefined) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const fsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      stat: async () => ({
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: Buffer.byteLength(indexedContent, 'utf8')
      }),
      readFile: async () => Uint8Array.from(Buffer.from(indexedContent))
    } as typeof vscode.workspace.fs);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => createPersistedSnapshot(
        workspaceUri,
        [{
          relativePath: 'src/app/main.ts',
          content: indexedContent,
          symbolName: 'MainService',
          symbolContentHash: hashContent(indexedContent)
        }],
        DEFAULT_PERSISTENCE_CONFIG_HASH,
        {
          availableLayers: ['file'],
          activeLayer: 'text'
        }
      )) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => registeredCommands.has('fastIndexer.goToFile'), 'goToFile registration');
      await waitFor(() => registeredCommands.has('fastIndexer.goToSymbol'), 'goToSymbol registration');

      await Promise.resolve(registeredCommands.get('fastIndexer.goToFile')?.());
      const goToSymbolPromise = Promise.resolve(registeredCommands.get('fastIndexer.goToSymbol')?.());
      const symbolOutcome = await Promise.race([
        goToSymbolPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20))
      ]);

      assert.equal(symbolOutcome, 'resolved');
      releaseSymbolLayer?.();
      await goToSymbolPromise;
    } finally {
      releaseSymbolLayer?.();
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(fsPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executePatch);
      restoreProperty(infoPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('restores persisted semantic metadata with indexed symbols and shows semantic detail in goToSymbol', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const indexedFile = vscode.Uri.parse('file:///workspace/src/app/main.ts');
    const semanticConfigHash = toPersistenceConfigHash({
      semanticEnrichment: true,
      semanticConcurrency: 5,
      semanticTimeoutMs: 5000
    });
    const persistedSnapshot = {
      metadata: {
        schemaVersion: 2,
        workspaceId: toExpectedWorkspaceId([workspaceUri]),
        configHash: semanticConfigHash
              },
        merkle: {
          rootHash: '',
          subtreeHashes: [],
          leaves: []
        },
        fileIndex: [{
        relativePath: 'src/app/main.ts',
        uri: 'file:///workspace/src/app/main.ts',
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['src', 'app', 'main', 'ts']
      }],
      textIndex: [],
      symbolIndex: [{
        relativePath: 'src/app/main.ts',
        contentHash: 'main-hash',
        symbols: [{
          name: 'MainService',
          kind: 5,
          containerName: undefined,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: 12,
          uri: 'file:///workspace/src/app/main.ts',
          approximate: false
        }]
      }],
      semanticIndex: [{
        relativePath: 'src/app/main.ts',
        entries: [{
          key: 'MainService:5::0:0',
          metadata: {
            referenceCount: 6,
            implementationCount: 2,
            provider: 'vscode',
            status: 'enriched',
            confidence: 1,
            enrichedAt: 123
          }
        }]
      }]
    };
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = resolve;
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: true,
            semanticConcurrency: 5,
            semanticTimeoutMs: 5000
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'main') as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );

    const goToSymbolCommandPromise = (async () => {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToSymbolCommand = registeredCommands.get('fastIndexer.goToSymbol');
      assert.ok(goToSymbolCommand, 'goToSymbol command should be registered');
      await Promise.resolve(goToSymbolCommand?.());
    })();

    try {
      const outcome = await Promise.race([
        goToSymbolCommandPromise.then(() => 'resolved'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50))
      ]);

      assert.equal(outcome, 'resolved');
      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'MainService');
      assert.equal(quickPickItems[0]?.detail, `${indexedFile.fsPath} • 6 refs • 2 impls • vscode`);
    } finally {
      resolveFindFiles?.([]);
      await goToSymbolCommandPromise;
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('findImplementations fallback uses restored symbol layer without waiting for current build', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const indexedContent = 'export class MainServiceImplementation {}';
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeImplementationProvider') {
        return [];
      }

      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [];
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = resolve;
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            providerFallback: true,
            symbolFallback: true,
            completionStyleResults: false,
            useRipgrep: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const activeEditorPatch = patchProperty(vscode.window, 'activeTextEditor', ({
      document: {
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\contract.ts'),
        getWordRangeAtPosition: () => new vscode.Range(0, 0, 0, 11),
        getText: () => 'MainService'
      },
      selection: {
        active: new vscode.Position(0, 0)
      }
    } as unknown as vscode.TextEditor) as typeof vscode.window.activeTextEditor);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => createPersistedSnapshot(
        workspaceUri,
        [{
          relativePath: 'src/app/main.ts',
          content: indexedContent,
          symbolName: 'MainServiceImplementation',
          symbolContentHash: hashContent(indexedContent)
        }],
        toPersistenceConfigHash({ semanticEnrichment: false }),
        {
          availableLayers: ['file', 'text', 'symbol'],
          activeLayer: undefined
        }
      )) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    const commandPromise = (async () => {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => registeredCommands.has('fastIndexer.findImplementations'), 'findImplementations command registration');
      await Promise.resolve(registeredCommands.get('fastIndexer.findImplementations')?.());
    })();

    try {
      const outcome = await Promise.race([
        commandPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50))
      ]);

      assert.equal(outcome, 'resolved');
      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'src/app/main.ts:1');
    } finally {
      resolveFindFiles?.([]);
      await commandPromise;
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(activeEditorPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('findUsages fallback uses restored text layer without waiting for current symbol hydration', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const indexedContent = 'export const usage = MainService;';
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;
    let findFilesCompleted = false;
    let referenceProviderCalls = 0;
    let documentSymbolProviderCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeReferenceProvider') {
        referenceProviderCalls += 1;
        return [];
      }

      if (command === 'vscode.executeDocumentSymbolProvider') {
        documentSymbolProviderCalls += 1;
        return new Promise<vscode.DocumentSymbol[]>(() => undefined);
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = (value) => {
          findFilesCompleted = true;
          resolve(value);
        };
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            providerFallback: true,
            symbolFallback: true,
            completionStyleResults: false,
            useRipgrep: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const activeEditorPatch = patchProperty(vscode.window, 'activeTextEditor', ({
      document: {
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\contract.ts'),
        getWordRangeAtPosition: () => new vscode.Range(0, 0, 0, 11),
        getText: () => 'MainService'
      },
      selection: {
        active: new vscode.Position(0, 0)
      }
    } as unknown as vscode.TextEditor) as typeof vscode.window.activeTextEditor);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => createPersistedSnapshot(
        workspaceUri,
        [{
          relativePath: 'src/app/main.ts',
          content: indexedContent,
          symbolName: 'UnrelatedSymbol',
          symbolContentHash: hashContent(indexedContent)
        }],
        toPersistenceConfigHash({ semanticEnrichment: false }),
        {
          availableLayers: ['file', 'text'],
          activeLayer: 'symbol'
        }
      )) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    const commandPromise = (async () => {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await waitFor(() => registeredCommands.has('fastIndexer.findUsages'), 'findUsages command registration');
      await Promise.resolve(registeredCommands.get('fastIndexer.findUsages')?.());
    })();

    try {
      const outcome = await Promise.race([
        commandPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50))
      ]);

      assert.equal(outcome, 'resolved');
      assert.equal(findFilesCompleted, false);
      assert.equal(referenceProviderCalls, 1);
      assert.equal(documentSymbolProviderCalls, 0);
      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'src/app/main.ts:1');
    } finally {
      resolveFindFiles?.([]);
      await commandPromise;
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(activeEditorPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('falls back to the normal build when a persisted snapshot schema version is incompatible', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    let clearedWorkspaceId: string | undefined;
    const persistedSnapshot = {
      metadata: {
        schemaVersion: 0,
        workspaceId: toExpectedWorkspaceId([workspaceUri]),
        configHash: DEFAULT_PERSISTENCE_CONFIG_HASH
              },
        merkle: {
          rootHash: '',
          subtreeHashes: [],
          leaves: []
        },
        fileIndex: [{
        relativePath: 'src/app/main.ts',
        uri: 'file:///workspace/src/app/main.ts',
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['src', 'app', 'main', 'ts']
      }],
      textIndex: [],
      symbolIndex: []
    };
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;
    let infoMessage: string | undefined;
    let showInputBoxCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub({
      [vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').fsPath]: 'export const main = 1;'
    }));
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = resolve;
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => {
      showInputBoxCalls += 1;
      return 'main';
    }) as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const persistenceClearPatch = patchProperty(
      PersistenceStore.prototype,
      'clearWorkspaceCache',
      (async (workspaceId: string) => {
        clearedWorkspaceId = workspaceId;
      }) as typeof PersistenceStore.prototype.clearWorkspaceCache
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      const commandPromise = Promise.resolve(goToFileCommand?.());
      const preBuildOutcome = await Promise.race([
        commandPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20))
      ]);

      assert.equal(preBuildOutcome, 'waiting');
      assert.equal(infoMessage, 'Building initial file index. Please wait a moment.');
      assert.equal(showInputBoxCalls, 0);

      resolveFindFiles?.([vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')]);
      await commandPromise;

      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'main.ts');
      assert.equal(clearedWorkspaceId, toExpectedWorkspaceId([workspaceUri]));
    } finally {
      restoreProperty(persistenceClearPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(registerPatch);
      restoreProperty(infoPatch);
      restoreProperty(outputPatch);
    }
  });

  test('falls back to the normal build when a persisted snapshot config hash is incompatible', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    let clearedWorkspaceId: string | undefined;
    const persistedSnapshot = {
      metadata: {
        schemaVersion: 1,
        workspaceId: toExpectedWorkspaceId([workspaceUri]),
        configHash: 'stale-config'
              },
        merkle: {
          rootHash: '',
          subtreeHashes: [],
          leaves: []
        },
        fileIndex: [{
        relativePath: 'src/app/main.ts',
        uri: 'file:///workspace/src/app/main.ts',
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['src', 'app', 'main', 'ts']
      }],
      textIndex: [],
      symbolIndex: []
    };
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;
    let infoMessage: string | undefined;
    let showInputBoxCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub({
      [vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').fsPath]: 'export const main = 1;'
    }));
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = resolve;
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => {
      showInputBoxCalls += 1;
      return 'main';
    }) as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const persistenceClearPatch = patchProperty(
      PersistenceStore.prototype,
      'clearWorkspaceCache',
      (async (workspaceId: string) => {
        clearedWorkspaceId = workspaceId;
      }) as typeof PersistenceStore.prototype.clearWorkspaceCache
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      const commandPromise = Promise.resolve(goToFileCommand?.());
      const preBuildOutcome = await Promise.race([
        commandPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20))
      ]);

      assert.equal(preBuildOutcome, 'waiting');
      assert.equal(infoMessage, 'Building initial file index. Please wait a moment.');
      assert.equal(showInputBoxCalls, 0);

      resolveFindFiles?.([vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')]);
      await commandPromise;

      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'main.ts');
      assert.equal(clearedWorkspaceId, toExpectedWorkspaceId([workspaceUri]));
    } finally {
      restoreProperty(persistenceClearPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(registerPatch);
      restoreProperty(infoPatch);
      restoreProperty(outputPatch);
    }
  });

  test('falls back to the normal build when persisted ignore inputs are incompatible', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-ignore-restore-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    const ignoreFilePath = path.join(workspaceRoot, '.fast-indexer-ignore');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'const value = 1;', 'utf8');
    await fs.writeFile(ignoreFilePath, 'generated/\n', 'utf8');

    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const workspaceUri = vscode.Uri.file(workspaceRoot);
    let clearedWorkspaceId: string | undefined;
    let persistedWrites = 0;
    const persistedSnapshot = {
      metadata: {
        schemaVersion: 2,
        workspaceId: toExpectedWorkspaceId([workspaceUri]),
        configHash: toPersistenceConfigHash({
          ignoreFiles: ['.fast-indexer-ignore'],
          sharedIgnoreFiles: [],
          ignoreInputs: [{
            path: ignoreFilePath.toLowerCase(),
            rules: ['generated/', '!generated/keep.ts']
          }]
        })
              },
        merkle: {
          rootHash: '',
          subtreeHashes: [],
          leaves: []
        },
        fileIndex: [{
        relativePath: 'src/app/main.ts',
        uri: vscode.Uri.file(indexedFilePath).toString(),
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['src', 'app', 'main', 'ts']
      }],
      textIndex: [],
      symbolIndex: []
    };
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;
    let infoMessage: string | undefined;
    let showInputBoxCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = resolve;
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            ignoreFiles: ['.fast-indexer-ignore'],
            sharedIgnoreFiles: []
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => {
      showInputBoxCalls += 1;
      return 'main';
    }) as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => {
        persistedWrites += 1;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );
    const persistenceClearPatch = patchProperty(
      PersistenceStore.prototype,
      'clearWorkspaceCache',
      (async (workspaceId: string) => {
        clearedWorkspaceId = workspaceId;
      }) as typeof PersistenceStore.prototype.clearWorkspaceCache
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      const commandPromise = Promise.resolve(goToFileCommand?.());
      const preBuildOutcome = await Promise.race([
        commandPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20))
      ]);

      assert.equal(preBuildOutcome, 'waiting');
      assert.equal(showInputBoxCalls, 0);

      resolveFindFiles?.([vscode.Uri.file(indexedFilePath)]);
      await commandPromise;
      await waitFor(() => persistedWrites >= 1, 'rebuilt snapshot after ignore-input invalidation');

      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'main.ts');
      assert.equal(clearedWorkspaceId, toExpectedWorkspaceId([workspaceUri]));
    } finally {
      restoreProperty(persistenceClearPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(registerPatch);
      restoreProperty(infoPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('restores a persisted snapshot using the full current workspace composition identity', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const firstWorkspaceUri = vscode.Uri.file('d:\\workspace-b');
    const secondWorkspaceUri = vscode.Uri.file('c:\\workspace-a');
    const expectedWorkspaceId = toExpectedWorkspaceId([firstWorkspaceUri, secondWorkspaceUri]);
    const persistedSnapshot = {
      metadata: {
        schemaVersion: 2,
        workspaceId: expectedWorkspaceId,
        configHash: DEFAULT_PERSISTENCE_CONFIG_HASH
              },
        merkle: {
          rootHash: '',
          subtreeHashes: [],
          leaves: []
        },
        fileIndex: [{
        relativePath: 'workspace-a/src/app/main.ts',
        uri: vscode.Uri.file('c:\\workspace-a\\src\\app\\main.ts').toString(),
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['workspace', 'a', 'src', 'app', 'main', 'ts']
      }],
      textIndex: [],
      symbolIndex: []
    };
    let requestedWorkspaceId: string | undefined;
    let resolveFindFiles: ((value: vscode.Uri[]) => void) | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (((_include: vscode.GlobPattern, _exclude?: vscode.GlobPattern | null) =>
      new Promise<vscode.Uri[]>((resolve) => {
        resolveFindFiles = resolve;
      })) as unknown) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return pathOrUri.fsPath.startsWith('c:')
        ? 'workspace-a/src/app/main.ts'
        : 'workspace-b/src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: uri.fsPath.startsWith('c:') ? secondWorkspaceUri : firstWorkspaceUri,
      index: uri.fsPath.startsWith('c:') ? 1 : 0,
      name: uri.fsPath.startsWith('c:') ? 'workspace-a' : 'workspace-b'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [
      {
        uri: firstWorkspaceUri,
        index: 0,
        name: 'workspace-b'
      },
      {
        uri: secondWorkspaceUri,
        index: 1,
        name: 'workspace-a'
      }
    ] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'main') as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.push(...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async (workspaceId: string) => {
        requestedWorkspaceId = workspaceId;
        return workspaceId === expectedWorkspaceId ? persistedSnapshot : undefined;
      }) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    const goToFileCommandPromise = (async () => {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      await Promise.resolve(goToFileCommand?.());
    })();

    try {
      const outcome = await Promise.race([
        goToFileCommandPromise.then(() => 'resolved'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50))
      ]);

      assert.equal(outcome, 'resolved');
      assert.equal(requestedWorkspaceId, expectedWorkspaceId);
      assert.equal(quickPickItems.length, 1);
      assert.equal(quickPickItems[0]?.label, 'main.ts');
    } finally {
      resolveFindFiles?.([]);
      await goToFileCommandPromise;
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('builds the workspace file index once during activation and reuses it', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const findFilesCalls: Array<{ include: vscode.GlobPattern; exclude?: vscode.GlobPattern | null; }> = [];

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async (
      include: vscode.GlobPattern,
      exclude?: vscode.GlobPattern | null
    ) => {
      findFilesCalls.push({ include, exclude });
      return [vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')];
    }) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => undefined) as typeof vscode.window.showInputBox);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      await Promise.resolve(goToFileCommand?.());
      await Promise.resolve(goToFileCommand?.());
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(inputPatch);
    }

    assert.equal(findFilesCalls.length, 1);
    assert.equal(findFilesCalls[0]?.include, '**/*');
    assert.equal(findFilesCalls[0]?.exclude, '{**/{node_modules,.git,.hg,.svn,.vscode-test,.worktrees,dist,build,coverage,out,target}/**,**/node_modules/**,**/.git/**}');
  });

  test('persists a fresh snapshot after a successful initial build', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-persist-build-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'const value = 1;', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const indexedFile = vscode.Uri.file(indexedFilePath);
    const expectedWorkspaceId = encodeURIComponent(workspaceUri.toString());
    let persisted:
      | {
        workspaceId: string;
        snapshot: {
          metadata: {
            schemaVersion: number;
            workspaceId: string;
            configHash: string;
          };
          fileIndex: Array<{ relativePath: string; }>;
          textIndex: Array<{ relativePath: string; content: string; }>;
          symbolIndex: Array<{ relativePath: string; symbols: Array<{ name: string; }>; }>;
        };
      }
      | undefined;
    let resolvePersisted: (() => void) | undefined;
    const persistedPromise = new Promise<void>((resolve) => {
      resolvePersisted = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'MainService',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 12),
          new vscode.Range(0, 0, 0, 12)
        )];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (workspaceId !== expectedWorkspaceId) {
          return;
        }

        if (!isCompleteLayerSnapshot(snapshot) || snapshot.symbolIndex[0]?.symbols[0]?.name !== 'MainService') {
          return;
        }

        persisted = { workspaceId, snapshot };
        resolvePersisted?.();
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const outcome = await Promise.race([
        persistedPromise.then(() => 'persisted'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
      ]);

      assert.equal(outcome, 'persisted');
      assert.equal(persisted?.workspaceId, expectedWorkspaceId);
      assert.equal(persisted?.snapshot.fileIndex.length, 1);
      assert.equal(persisted?.snapshot.fileIndex[0]?.relativePath, 'src/app/main.ts');
      assert.equal(persisted?.snapshot.textIndex[0]?.content, 'const value = 1;');
      assert.equal(persisted?.snapshot.symbolIndex[0]?.symbols[0]?.name, 'MainService');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('persists symbol entries with the file content hash when text indexing does not produce text content', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-persist-symbol-hash-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'const value = 1;', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const indexedFile = vscode.Uri.file(indexedFilePath);
    const expectedWorkspaceId = encodeURIComponent(workspaceUri.toString());
    let persisted:
      | {
        workspaceId: string;
        snapshot: {
          merkle: {
            leaves: Array<{ relativePath: string }>;
          };
          textIndex: Array<{ relativePath: string; content: string }>;
          symbolIndex: Array<{ relativePath: string; contentHash: string | null; symbols: Array<{ name: string }> }>;
        };
      }
      | undefined;
    let resolvePersisted: (() => void) | undefined;
    const persistedPromise = new Promise<void>((resolve) => {
      resolvePersisted = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'MainService',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 12),
          new vscode.Range(0, 0, 0, 12)
        )];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            maxFileSizeKb: 0
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (workspaceId !== expectedWorkspaceId) {
          return;
        }

        if (!isCompleteLayerSnapshot(snapshot) || snapshot.symbolIndex.length === 0) {
          return;
        }

        persisted = { workspaceId, snapshot };
        resolvePersisted?.();
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const outcome = await Promise.race([
        persistedPromise.then(() => 'persisted'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
      ]);

      assert.equal(outcome, 'persisted');
      assert.equal(persisted?.snapshot.merkle.leaves.length, 1);
      assert.equal(persisted?.snapshot.merkle.leaves[0]?.relativePath, 'src/app/main.ts');
      assert.equal(persisted?.snapshot.textIndex.length, 0);
      assert.equal(persisted?.snapshot.symbolIndex.length, 1);
      assert.equal(persisted?.snapshot.symbolIndex[0]?.relativePath, 'src/app/main.ts');
      assert.equal(persisted?.snapshot.symbolIndex[0]?.contentHash, hashContent('const value = 1;'));
      assert.equal(persisted?.snapshot.symbolIndex[0]?.symbols[0]?.name, 'MainService');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('persists a fresh snapshot after an explicit rebuild completes', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-persist-rebuild-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'const value = 1;', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const indexedFile = vscode.Uri.file(indexedFilePath);
    const expectedWorkspaceId = toExpectedWorkspaceId([workspaceUri]);
    const persistedWrites: Array<{
      workspaceId: string;
      snapshot: {
        metadata: {
          schemaVersion: number;
          workspaceId: string;
          configHash: string;
        };
        fileIndex: Array<{ relativePath: string; }>;
        textIndex: Array<{ relativePath: string; content: string; }>;
        symbolIndex: Array<{ relativePath: string; symbols: Array<{ name: string; }>; }>;
      };
    }> = [];
    let resolveInitialWrite: (() => void) | undefined;
    let resolveRebuildWrite: (() => void) | undefined;
    const initialWritePromise = new Promise<void>((resolve) => {
      resolveInitialWrite = resolve;
    });
    const rebuildWritePromise = new Promise<void>((resolve) => {
      resolveRebuildWrite = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'MainService',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 12),
          new vscode.Range(0, 0, 0, 12)
        )];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const progressPatch = patchProperty(vscode.window, 'withProgress', (async (...args: Parameters<typeof vscode.window.withProgress>) => {
      return args[1]({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
    }) as typeof vscode.window.withProgress);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (workspaceId !== expectedWorkspaceId) {
          return;
        }

        if (!isCompleteLayerSnapshot(snapshot) || snapshot.symbolIndex[0]?.symbols[0]?.name !== 'MainService') {
          return;
        }

        persistedWrites.push({ workspaceId, snapshot });
        if (persistedWrites.length === 1) {
          resolveInitialWrite?.();
        }
        if (persistedWrites.length === 2) {
          resolveRebuildWrite?.();
        }
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);
      await initialWritePromise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const rebuildIndexCommand = registeredCommands.get('fastIndexer.rebuildIndex');
      assert.ok(rebuildIndexCommand, 'rebuildIndex command should be registered');
      await Promise.resolve(rebuildIndexCommand?.());
      await rebuildWritePromise;

      assert.equal(persistedWrites.length, 2);
      assert.equal(persistedWrites[0]?.workspaceId, expectedWorkspaceId);
      assert.equal(persistedWrites[1]?.workspaceId, expectedWorkspaceId);
      assert.equal(persistedWrites[1]?.snapshot.fileIndex[0]?.relativePath, 'src/app/main.ts');
      assert.equal(persistedWrites[1]?.snapshot.textIndex[0]?.content, 'const value = 1;');
      assert.equal(persistedWrites[1]?.snapshot.symbolIndex[0]?.symbols[0]?.name, 'MainService');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(progressPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('recovers from a merkle scan read failure without persisting stale deleted entries', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-read-fallback-'));
    const keptFilePath = path.join(workspaceRoot, 'src', 'app', 'kept.ts');
    const deletedFilePath = path.join(workspaceRoot, 'src', 'app', 'deleted.ts');
    await fs.mkdir(path.dirname(keptFilePath), { recursive: true });
    await fs.writeFile(keptFilePath, 'export const kept = 1;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const keptUri = vscode.Uri.file(keptFilePath);
    const persistedSnapshot = createPersistedSnapshot(workspaceUri, [
      {
        relativePath: 'src/app/kept.ts',
        content: 'export const kept = 1;\n',
        symbolName: 'KeptService',
        symbolContentHash: hashContent('export const kept = 1;\n')
      },
      {
        relativePath: 'src/app/deleted.ts',
        content: 'export const deleted = 1;\n',
        symbolName: 'DeletedService',
        symbolContentHash: hashContent('export const deleted = 1;\n')
      }
    ], toPersistenceConfigHash({ semanticEnrichment: false }));
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPickItems: vscode.QuickPickItem[] = [];
    const expectedWorkspaceId = encodeURIComponent(workspaceUri.toString());
    let capturedSnapshot: PersistedWorkspaceSnapshot | undefined;
    let resolvePersisted: (() => void) | undefined;
    const persistedPromise = new Promise<void>((resolve) => {
      resolvePersisted = resolve;
    });
    let merkleReadFailures = 0;
    const originalWorkspaceFs = vscode.workspace.fs;
    const originalReadFile = originalWorkspaceFs.readFile.bind(originalWorkspaceFs);

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'KeptService',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 6),
          new vscode.Range(0, 0, 0, 6)
        )];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      readFile: (async (uri: vscode.Uri) => {
        if (path.resolve(uri.fsPath).toLowerCase() === path.resolve(keptFilePath).toLowerCase() && merkleReadFailures === 0) {
          merkleReadFailures += 1;
          throw new Error('transient merkle read failure');
        }

        return originalReadFile(uri);
      }) as typeof vscode.workspace.fs.readFile
    } as typeof vscode.workspace.fs);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [keptUri]) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string'
        ? pathOrUri
        : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.fsPath.startsWith(workspaceRoot) ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'kept') as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
      quickPickItems.splice(0, quickPickItems.length, ...items);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (workspaceId !== expectedWorkspaceId) {
          return;
        }

        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        capturedSnapshot = snapshot;
        resolvePersisted?.();
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const outcome = await Promise.race([
        persistedPromise.then(() => 'persisted'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1000))
      ]);

      assert.equal(outcome, 'persisted');
      assert.deepEqual(capturedSnapshot?.fileIndex.map((entry) => entry.relativePath), ['src/app/kept.ts']);
      assert.deepEqual(capturedSnapshot?.merkle.leaves.map((leaf) => leaf.relativePath), ['src/app/kept.ts']);
      assert.deepEqual(capturedSnapshot?.symbolIndex.map((entry) => entry.relativePath), ['src/app/kept.ts']);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      await Promise.resolve(goToFileCommand?.());
      assert.equal(quickPickItems.some((item) => item.label === path.basename(deletedFilePath)), false);
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('persists a rebuilt file after a transient merkle read failure during a full build', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-full-retry-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'const value = 1;', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const indexedFile = vscode.Uri.file(indexedFilePath);
    const expectedWorkspaceId = encodeURIComponent(workspaceUri.toString());
    let persisted:
      | {
        workspaceId: string;
        snapshot: PersistedWorkspaceSnapshot;
      }
      | undefined;
    let resolvePersisted: (() => void) | undefined;
    const persistedPromise = new Promise<void>((resolve) => {
      resolvePersisted = resolve;
    });
    let readFailures = 0;
    const originalWorkspaceFs = vscode.workspace.fs;
    const originalReadFile = originalWorkspaceFs.readFile.bind(originalWorkspaceFs);

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'MainService',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 12),
          new vscode.Range(0, 0, 0, 12)
        )];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      readFile: (async (uri: vscode.Uri) => {
        if (path.resolve(uri.fsPath).toLowerCase() === path.resolve(indexedFilePath).toLowerCase() && readFailures === 0) {
          readFailures += 1;
          throw new Error('transient full-build merkle read failure');
        }

        return originalReadFile(uri);
      }) as typeof vscode.workspace.fs.readFile
    } as typeof vscode.workspace.fs);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (workspaceId !== expectedWorkspaceId) {
          return;
        }

        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persisted = { workspaceId, snapshot };
        resolvePersisted?.();
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const outcome = await Promise.race([
        persistedPromise.then(() => 'persisted'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
      ]);

      assert.equal(outcome, 'persisted');
      assert.deepEqual(persisted?.snapshot.fileIndex.map((entry) => entry.relativePath), ['src/app/main.ts']);
      assert.deepEqual(persisted?.snapshot.merkle.leaves.map((leaf) => leaf.relativePath), ['src/app/main.ts']);
      assert.deepEqual(persisted?.snapshot.textIndex.map((entry) => entry.relativePath), ['src/app/main.ts']);
      assert.deepEqual(persisted?.snapshot.symbolIndex.map((entry) => entry.relativePath), ['src/app/main.ts']);
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('uses configured include and exclude globs during activation', async () => {
    const findFilesCalls: Array<{ include: vscode.GlobPattern; exclude?: vscode.GlobPattern | null; }> = [];

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            include: ['src/**/*.ts', 'lib/**/*.ts'],
            exclude: ['**/*.snap']
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async (
      include: vscode.GlobPattern,
      exclude?: vscode.GlobPattern | null
    ) => {
      findFilesCalls.push({ include, exclude });
      return [];
    }) as typeof vscode.workspace.findFiles);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
    }

    assert.deepEqual(findFilesCalls, [
      {
        include: '{src/**/*.ts,lib/**/*.ts}',
        exclude: '{**/{node_modules,.git,.hg,.svn,.vscode-test,.worktrees,dist,build,coverage,out,target}/**,**/*.snap}'
      }
    ]);
  });

  test('applies configured ignore-file rules before persisting the initial index snapshot', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-ignore-build-'));
    const mainFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    const ignoredFilePath = path.join(workspaceRoot, 'generated', 'value.ts');
    const restoredFilePath = path.join(workspaceRoot, 'generated', 'keep.ts');
    const ignoreFilePath = path.join(workspaceRoot, '.fast-indexer-ignore');
    await fs.mkdir(path.dirname(mainFilePath), { recursive: true });
    await fs.mkdir(path.dirname(ignoredFilePath), { recursive: true });
    await fs.writeFile(mainFilePath, 'export const main = 1;', 'utf8');
    await fs.writeFile(ignoredFilePath, 'export const ignored = true;', 'utf8');
    await fs.writeFile(restoredFilePath, 'export const keep = true;', 'utf8');
    await fs.writeFile(ignoreFilePath, 'generated/\n!generated/keep.ts\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    let resolvePersisted: ((value: {
      workspaceId: string;
      snapshot: {
        fileIndex: Array<{ relativePath: string; }>;
        textIndex: Array<{ relativePath: string; }>;
      };
    }) => void) | undefined;
    const persistedPromise = new Promise<{
      workspaceId: string;
      snapshot: {
        fileIndex: Array<{ relativePath: string; }>;
        textIndex: Array<{ relativePath: string; }>;
      };
    }>((resolve) => {
      resolvePersisted = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            ignoreFiles: ['.fast-indexer-ignore'],
            sharedIgnoreFiles: []
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file(mainFilePath),
      vscode.Uri.file(ignoredFilePath),
      vscode.Uri.file(restoredFilePath)
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        resolvePersisted?.({
          workspaceId,
          snapshot: {
            fileIndex: snapshot.fileIndex,
            textIndex: snapshot.textIndex
          }
        });
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const persisted = await Promise.race([
        persistedPromise,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 2000))
      ]);

      assert.notEqual(persisted, 'timed-out');
      if (persisted === 'timed-out') {
        throw new Error('Expected activation to persist the initial snapshot');
      }
      assert.deepEqual(
        [...persisted.snapshot.fileIndex.map((entry) => entry.relativePath)].sort(),
        ['generated/keep.ts', 'src/app/main.ts']
      );
      assert.deepEqual(
        [...persisted.snapshot.textIndex.map((entry) => entry.relativePath)].sort(),
        ['generated/keep.ts', 'src/app/main.ts']
      );
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('keeps missing configured ignore files non-fatal and surfaces diagnostic output', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-ignore-missing-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'export const main = 1;', 'utf8');

    const outputLines: string[] = [];
    const workspaceUri = vscode.Uri.file(workspaceRoot);
    let persistedWrites = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: (value: string) => {
        outputLines.push(value);
      },
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            ignoreFiles: ['.fast-indexer-ignore'],
            sharedIgnoreFiles: []
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file(indexedFilePath)
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persistedWrites += 1;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => persistedWrites >= 1, 'persisted snapshot with missing ignore file');
      assert.ok(
        outputLines.some((line) => line.includes('Skipping ignore file') && line.includes('.fast-indexer-ignore')),
        'expected a non-fatal missing ignore-file diagnostic'
      );
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('persists ignore configuration and loaded ignore inputs in snapshot metadata', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-ignore-hash-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    const ignoreFilePath = path.join(workspaceRoot, '.fast-indexer-ignore');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'export const main = 1;', 'utf8');
    await fs.writeFile(ignoreFilePath, 'generated/\n!generated/keep.ts\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    let persisted:
      | {
        snapshot: {
          metadata: {
            configHash: string;
          };
        };
      }
      | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            ignoreFiles: ['.fast-indexer-ignore'],
            sharedIgnoreFiles: []
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file(indexedFilePath)
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        persisted = { snapshot };
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => persisted !== undefined, 'persisted ignore-aware snapshot');
      assert.equal(
        persisted?.snapshot.metadata.configHash,
        toPersistenceConfigHash({
          ignoreFiles: ['.fast-indexer-ignore'],
          sharedIgnoreFiles: [],
          ignoreInputs: [{
            path: ignoreFilePath.toLowerCase(),
            rules: ['generated/', '!generated/keep.ts']
          }]
        })
      );
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('shows a warming notice before waiting for the initial file index build', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let infoMessage: string | undefined;
    let resolveFindFiles: ((files: vscode.Uri[]) => void) | undefined;
    let showInputBoxCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', ((() => new Promise<vscode.Uri[]>((resolve) => {
      resolveFindFiles = resolve;
    })) as unknown) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => {
      showInputBoxCalls += 1;
      return undefined;
    }) as typeof vscode.window.showInputBox);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      const commandPromise = Promise.resolve(goToFileCommand?.());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(infoMessage, 'Building initial file index. Please wait a moment.');
      assert.equal(showInputBoxCalls, 0);

      resolveFindFiles?.([vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')]);
      await commandPromise;
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(infoPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(inputPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
    }
  });

  test('shows a warming notice before waiting for the initial text index build', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let infoMessage: string | undefined;
    let resolveFindFiles: ((files: vscode.Uri[]) => void) | undefined;
    let showInputBoxCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', ((() => new Promise<vscode.Uri[]>((resolve) => {
      resolveFindFiles = resolve;
    })) as unknown) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => {
      showInputBoxCalls += 1;
      return undefined;
    }) as typeof vscode.window.showInputBox);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToTextCommand = registeredCommands.get('fastIndexer.goToText');
      assert.ok(goToTextCommand, 'goToText command should be registered');

      const commandPromise = Promise.resolve(goToTextCommand?.());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(infoMessage, 'Building initial text index. Please wait a moment.');
      assert.equal(showInputBoxCalls, 0);

      resolveFindFiles?.([vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')]);
      await commandPromise;
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(infoPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(inputPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
    }
  });

  test('keeps file indexing disabled when the setting is off', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let infoMessage: string | undefined;
    let findFilesCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: false
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => {
      findFilesCalls += 1;
      return [];
    }) as typeof vscode.workspace.findFiles);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      await Promise.resolve(goToFileCommand?.());
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(infoPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configListenerPatch);
    }

    assert.equal(findFilesCalls, 0);
    assert.equal(infoMessage, 'Fast Symbol Indexer indexing is disabled.');
  });

  test('keeps discovery commands disabled when indexing is off', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let infoMessage: string | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: false
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const findUsagesCommand = registeredCommands.get('fastIndexer.findUsages');
      assert.ok(findUsagesCommand, 'findUsages command should be registered');
      await Promise.resolve(findUsagesCommand?.());
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(infoPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configListenerPatch);
    }

    assert.equal(infoMessage, 'Fast Symbol Indexer indexing is disabled.');
  });

  test('waits for a newly enabled index build before running file commands', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let enabled = false;
    let configurationListener: ((event: vscode.ConfigurationChangeEvent) => unknown) | undefined;
    let infoMessage: string | undefined;
    let resolveFindFiles: ((files: vscode.Uri[]) => void) | undefined;
    let showInputBoxCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', ((() => new Promise<vscode.Uri[]>((resolve) => {
      resolveFindFiles = resolve;
    })) as unknown) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => {
      showInputBoxCalls += 1;
      return undefined;
    }) as typeof vscode.window.showInputBox);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      configurationListener = listener;
      return new vscode.Disposable(() => {
        configurationListener = undefined;
      });
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      assert.ok(configurationListener, 'configuration listener should be registered');

      enabled = true;
      configurationListener?.({
        affectsConfiguration: (key: string) => key === 'fastIndexer.enabled'
      } as vscode.ConfigurationChangeEvent);

      const commandPromise = Promise.resolve(goToFileCommand?.());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(infoMessage, 'Building initial file index. Please wait a moment.');
      assert.equal(showInputBoxCalls, 0);

      resolveFindFiles?.([vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')]);
      await commandPromise;
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(infoPatch);
      restoreProperty(inputPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
    }
  });

  test('stops an in-flight initial build after indexing is disabled', async () => {
    const files = [
      vscode.Uri.file('c:\\workspace\\src\\first.ts'),
      vscode.Uri.file('c:\\workspace\\src\\second.ts')
    ];
    let enabled = true;
    let configurationListener: ((event: vscode.ConfigurationChangeEvent) => unknown) | undefined;
    let executeCalls = 0;
    let releaseFirstSymbols: (() => void) | undefined;
    let firstSymbolsStarted: (() => void) | undefined;
    const firstSymbolsStartedPromise = new Promise<void>((resolve) => {
      firstSymbolsStarted = resolve;
    });
    const firstSymbolsGate = new Promise<void>((resolve) => {
      releaseFirstSymbols = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub({
      [files[0]!.fsPath]: 'export const first = 1;',
      [files[1]!.fsPath]: 'export const second = 2;'
    }));
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : `src/${pathOrUri.path.split('/').pop()}`;
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      configurationListener = listener;
      return new vscode.Disposable(() => {
        configurationListener = undefined;
      });
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command !== 'vscode.executeDocumentSymbolProvider') {
        return [];
      }

      executeCalls += 1;
      if (executeCalls === 1) {
        firstSymbolsStarted?.();
        await firstSymbolsGate;
      }

      return [];
    }) as typeof vscode.commands.executeCommand);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await firstSymbolsStartedPromise;
      assert.ok(configurationListener, 'configuration listener should be registered');

      enabled = false;
      configurationListener?.({
        affectsConfiguration: (key: string) => key === 'fastIndexer.enabled'
      } as vscode.ConfigurationChangeEvent);
      releaseFirstSymbols?.();

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(executePatch);
    }

    assert.equal(executeCalls, 1, 'disabling indexing should stop the in-flight build before later files are processed');
  });

  test('skips file processing when indexing is disabled before file discovery completes', async () => {
    let enabled = true;
    let configurationListener: ((event: vscode.ConfigurationChangeEvent) => unknown) | undefined;
    let resolveFindFiles: ((files: vscode.Uri[]) => void) | undefined;
    let executeCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', ((() => new Promise<vscode.Uri[]>((resolve) => {
      resolveFindFiles = resolve;
    })) as unknown) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : `src/${pathOrUri.path.split('/').pop()}`;
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      configurationListener = listener;
      return new vscode.Disposable(() => {
        configurationListener = undefined;
      });
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => {
      executeCalls += 1;
      return [];
    }) as typeof vscode.commands.executeCommand);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      assert.ok(configurationListener, 'configuration listener should be registered');
      enabled = false;
      configurationListener?.({
        affectsConfiguration: (key: string) => key === 'fastIndexer.enabled'
      } as vscode.ConfigurationChangeEvent);
      resolveFindFiles?.([
        vscode.Uri.file('c:\\workspace\\src\\first.ts'),
        vscode.Uri.file('c:\\workspace\\src\\second.ts')
      ]);

      await Promise.resolve();
      await Promise.resolve();
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(executePatch);
    }

    assert.equal(executeCalls, 0, 'no file processing should start after indexing is disabled during file discovery');
  });

  test('keeps same-folder-name workspace entries distinct during the initial build', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPick = new FakeQuickPick<vscode.QuickPickItem & { description?: string; }>();
    const firstFile = vscode.Uri.file('c:\\repos\\workspace\\src\\app\\main.ts');
    const secondFile = vscode.Uri.file('d:\\repos\\workspace\\src\\app\\main.ts');

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub({
      [firstFile.fsPath]: 'export const main = 1;',
      [secondFile.fsPath]: 'export const main = 2;'
    }));
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [firstFile, secondFile]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'workspace/src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file(uri.fsPath.startsWith('c:') ? 'c:\\repos\\workspace' : 'd:\\repos\\workspace'),
      index: uri.fsPath.startsWith('c:') ? 0 : 1,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const quickPickPatch = patchProperty(vscode.window, 'createQuickPick', ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      await Promise.resolve(goToFileCommand?.());
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
    }

    assert.equal(quickPick.items.length, 2);
    assert.deepEqual(quickPick.items.map((item) => item.description), [
      'workspace/src/app/main.ts',
      'workspace/src/app/main.ts'
    ]);
  });

  test('checks file size before reading file contents for text indexing', async () => {
    const smallFile = vscode.Uri.file('c:\\workspace\\src\\small.ts');
    const largeFile = vscode.Uri.file('c:\\workspace\\src\\large.ts');
    const statCalls: string[] = [];
    const readCalls: string[] = [];
    const fileSystem = {
      stat: async (uri: vscode.Uri) => {
        statCalls.push(uri.fsPath);
        return {
          type: vscode.FileType.File,
          ctime: 0,
          mtime: 0,
          size: uri.fsPath.endsWith('large.ts') ? 1025 : 1024
        };
      },
      readFile: async (uri: vscode.Uri) => {
        readCalls.push(uri.fsPath);
        return Buffer.from('export const value = 1;');
      }
    };

    const smallContent = await readEligibleTextContent(fileSystem, smallFile, 'src/small.ts', 1);
    const largeContent = await readEligibleTextContent(fileSystem, largeFile, 'src/large.ts', 1);

    assert.deepEqual(statCalls, [
      'c:\\workspace\\src\\small.ts',
      'c:\\workspace\\src\\large.ts'
    ]);
    assert.deepEqual(readCalls, ['c:\\workspace\\src\\small.ts']);
    assert.equal(smallContent, 'export const value = 1;');
    assert.equal(largeContent, undefined);
  });

  test('shows an informational message instead of rebuilding while the initial index build is still running', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let infoMessage: string | undefined;
    let resolveFindFiles: ((files: vscode.Uri[]) => void) | undefined;
    let withProgressCalls = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const progressPatch = patchProperty(vscode.window, 'withProgress', (async (...args: Parameters<typeof vscode.window.withProgress>) => {
      withProgressCalls += 1;
      return args[1]({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
    }) as typeof vscode.window.withProgress);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', ((() => new Promise<vscode.Uri[]>((resolve) => {
      resolveFindFiles = resolve;
    })) as unknown) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const rebuildIndexCommand = registeredCommands.get('fastIndexer.rebuildIndex');
      assert.ok(rebuildIndexCommand, 'rebuildIndex command should be registered');

      await Promise.resolve(rebuildIndexCommand?.());

      assert.equal(infoMessage, 'Initial index build is still running. Please wait for it to finish before rebuilding.');
      assert.equal(withProgressCalls, 0);

      resolveFindFiles?.([vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')]);
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(infoPatch);
      restoreProperty(progressPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
    }
  });

  test('ignores watcher updates from excluded heavy paths', async function () {
    this.timeout(10000);
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let onDidCreate: ((uri: vscode.Uri) => void) | undefined;
    const providerCalls: string[] = [];

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub({
      [vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').fsPath]: 'export const main = 1;'
    }));
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return pathOrUri.fsPath.includes('node_modules')
        ? 'node_modules/pkg/index.js'
        : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
      if (command === 'vscode.executeDocumentSymbolProvider' && uri) {
        providerCalls.push(uri.fsPath);
        return [];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => undefined) as typeof vscode.window.showInputBox);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: (listener: (uri: vscode.Uri) => void) => {
        onDidCreate = listener;
        return new vscode.Disposable(() => {
          onDidCreate = undefined;
        });
      },
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      await Promise.resolve(goToFileCommand?.());

      assert.ok(onDidCreate, 'watcher create handler should be registered');
      const providerCallCountBefore = providerCalls.length;
      onDidCreate?.(vscode.Uri.file('c:\\workspace\\node_modules\\pkg\\index.js'));

      await Promise.resolve();
      await Promise.resolve();
      assert.equal(providerCalls.length, providerCallCountBefore);
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(inputPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
    }
  });

  test('refreshes ignore-file watcher behavior after a configured ignore file changes', async function () {
    this.timeout(10000);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-ignore-watch-'));
    const mainFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    const ignoredFilePath = path.join(workspaceRoot, 'generated', 'value.ts');
    const restoredFilePath = path.join(workspaceRoot, 'generated', 'keep.ts');
    const ignoreFilePath = path.join(workspaceRoot, '.fast-indexer-ignore');
    await fs.mkdir(path.dirname(mainFilePath), { recursive: true });
    await fs.mkdir(path.dirname(ignoredFilePath), { recursive: true });
    await fs.writeFile(mainFilePath, 'export const main = 1;', 'utf8');
    await fs.writeFile(ignoredFilePath, 'export const ignored = true;', 'utf8');
    await fs.writeFile(restoredFilePath, 'export const keep = true;', 'utf8');
    await fs.writeFile(ignoreFilePath, 'generated/\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    let onDidCreate: ((uri: vscode.Uri) => void) | undefined;
    let onDidChange: ((uri: vscode.Uri) => void) | undefined;
    let persistedWrites = 0;
    let staleMarks = 0;
    const originalMarkStale = IndexCoordinator.prototype.markStale;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            debounceMs: 1,
            ignoreFiles: ['.fast-indexer-ignore'],
            sharedIgnoreFiles: []
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file(mainFilePath)
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: (listener: (uri: vscode.Uri) => void) => {
        onDidCreate = listener;
        return new vscode.Disposable(() => {
          onDidCreate = undefined;
        });
      },
      onDidChange: (listener: (uri: vscode.Uri) => void) => {
        onDidChange = listener;
        return new vscode.Disposable(() => {
          onDidChange = undefined;
        });
      },
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const markStalePatch = patchProperty(
      IndexCoordinator.prototype,
      'markStale',
      (function (this: IndexCoordinator) {
        staleMarks += 1;
        return originalMarkStale.call(this);
      }) as typeof IndexCoordinator.prototype.markStale
    );
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persistedWrites += 1;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);
      await waitFor(() => persistedWrites >= 1, 'initial persisted snapshot');

      assert.ok(onDidCreate, 'watcher create handler should be registered');
      assert.ok(onDidChange, 'watcher change handler should be registered');

      onDidCreate?.(vscode.Uri.file(ignoredFilePath));
      assert.equal(staleMarks, 0);

      await fs.writeFile(ignoreFilePath, 'generated/\n!generated/keep.ts\n', 'utf8');
      await waitForAsync(async () => {
        const contents = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(ignoreFilePath))).toString('utf8');
        return contents.includes('!generated/keep.ts');
      }, 'updated ignore file contents');
      onDidChange?.(vscode.Uri.file(ignoreFilePath));
      await waitFor(() => staleMarks >= 1, 'ignore-file change to mark the index stale');
      await waitFor(() => persistedWrites >= 2, 'ignore-file refresh rebuild');

      onDidCreate?.(vscode.Uri.file(restoredFilePath));
      await waitFor(() => staleMarks >= 2, 'restored watcher update after ignore refresh');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(markStalePatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('reindexes only the changed file after a watcher change event', async function () {
    this.timeout(10000);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-watch-change-'));
    const alphaPath = path.join(workspaceRoot, 'src', 'alpha.ts');
    const betaPath = path.join(workspaceRoot, 'src', 'beta.ts');
    await fs.mkdir(path.dirname(alphaPath), { recursive: true });
    await fs.writeFile(alphaPath, 'export const alpha = 1;\n', 'utf8');
    await fs.writeFile(betaPath, 'export const beta = 1;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const providerCalls: string[] = [];
    let onDidChange: ((uri: vscode.Uri) => void) | undefined;
    let persistedWrites = 0;
    let persistedSnapshot: PersistedWorkspaceSnapshot | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
      if (command === 'vscode.executeDocumentSymbolProvider' && uri) {
        providerCalls.push(uri.fsPath);
        return [];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            debounceMs: 1,
            semanticEnrichment: false
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file(alphaPath),
      vscode.Uri.file(betaPath)
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: (listener: (uri: vscode.Uri) => void) => {
        onDidChange = listener;
        return new vscode.Disposable(() => {
          onDidChange = undefined;
        });
      },
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persistedWrites += 1;
        persistedSnapshot = snapshot;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => persistedWrites >= 1, 'initial watcher snapshot');
      assert.ok(onDidChange, 'watcher change handler should be registered');

      providerCalls.splice(0, providerCalls.length);
      await fs.writeFile(betaPath, 'export const beta = 2;\n', 'utf8');
      onDidChange?.(vscode.Uri.file(betaPath));

      await waitFor(() => providerCalls.length === 1, 'single-file watcher rebuild');
      await waitFor(() => persistedWrites >= 2, 'watcher change snapshot');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    assert.deepEqual(
      providerCalls.map((entry) => normalizeWorkspaceFsTestPath(entry)),
      [normalizeWorkspaceFsTestPath(betaPath)]
    );
    assert.equal(
      persistedSnapshot?.textIndex.find((entry) => entry.relativePath === 'src/beta.ts')?.content,
      'export const beta = 2;\n'
    );
    assert.equal(
      persistedSnapshot?.merkle.leaves.find((leaf) => leaf.relativePath === 'src/beta.ts')?.contentHash,
      hashContent('export const beta = 2;\n')
    );
  });

  test('removes file, text, and symbol caches after a watcher delete event', async function () {
    this.timeout(10000);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-watch-delete-'));
    const alphaPath = path.join(workspaceRoot, 'src', 'alpha.ts');
    const betaPath = path.join(workspaceRoot, 'src', 'beta.ts');
    await fs.mkdir(path.dirname(alphaPath), { recursive: true });
    await fs.writeFile(alphaPath, 'export const alpha = 1;\n', 'utf8');
    await fs.writeFile(betaPath, 'export const beta = 1;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const providerCalls: string[] = [];
    let onDidDelete: ((uri: vscode.Uri) => void) | undefined;
    let persistedWrites = 0;
    let persistedSnapshot: PersistedWorkspaceSnapshot | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
      if (command === 'vscode.executeDocumentSymbolProvider' && uri) {
        providerCalls.push(uri.fsPath);
        return [{
          name: path.basename(uri.fsPath, '.ts'),
          kind: vscode.SymbolKind.Function,
          range: new vscode.Range(0, 0, 0, 10),
          selectionRange: new vscode.Range(0, 0, 0, 10),
          children: []
        }];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            debounceMs: 1,
            semanticEnrichment: false
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file(alphaPath),
      vscode.Uri.file(betaPath)
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: (listener: (uri: vscode.Uri) => void) => {
        onDidDelete = listener;
        return new vscode.Disposable(() => {
          onDidDelete = undefined;
        });
      },
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persistedWrites += 1;
        persistedSnapshot = snapshot;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => persistedWrites >= 1, 'initial delete snapshot');
      assert.ok(onDidDelete, 'watcher delete handler should be registered');

      providerCalls.splice(0, providerCalls.length);
      await fs.rm(alphaPath, { force: true });
      onDidDelete?.(vscode.Uri.file(alphaPath));

      await waitFor(() => persistedWrites >= 2, 'watcher delete snapshot');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    assert.deepEqual(providerCalls, []);
    assert.equal(persistedSnapshot?.fileIndex.some((entry) => entry.relativePath === 'src/alpha.ts'), false);
    assert.equal(persistedSnapshot?.textIndex.some((entry) => entry.relativePath === 'src/alpha.ts'), false);
    assert.equal(persistedSnapshot?.symbolIndex.some((entry) => entry.relativePath === 'src/alpha.ts'), false);
    assert.equal(persistedSnapshot?.fileIndex.some((entry) => entry.relativePath === 'src/beta.ts'), true);
  });

  test('treats a missing changed file as a delete during incremental watcher updates', async function () {
    this.timeout(10000);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-watch-missing-'));
    const alphaPath = path.join(workspaceRoot, 'src', 'alpha.ts');
    const betaPath = path.join(workspaceRoot, 'src', 'beta.ts');
    await fs.mkdir(path.dirname(alphaPath), { recursive: true });
    await fs.writeFile(alphaPath, 'export const alpha = 1;\n', 'utf8');
    await fs.writeFile(betaPath, 'export const beta = 1;\n', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const providerCalls: string[] = [];
    let onDidChange: ((uri: vscode.Uri) => void) | undefined;
    let persistedWrites = 0;
    let persistedSnapshot: PersistedWorkspaceSnapshot | undefined;
    let failMissingBeta = false;
    const originalWorkspaceFs = vscode.workspace.fs;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
      if (command === 'vscode.executeDocumentSymbolProvider' && uri) {
        providerCalls.push(uri.fsPath);
        return [];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      readFile: async (uri: vscode.Uri) => {
        if (failMissingBeta && normalizeWorkspaceFsTestPath(uri.fsPath) === normalizeWorkspaceFsTestPath(betaPath)) {
          const error = new Error('missing beta') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }

        return originalWorkspaceFs.readFile(uri);
      },
      stat: async (uri: vscode.Uri) => {
        if (failMissingBeta && normalizeWorkspaceFsTestPath(uri.fsPath) === normalizeWorkspaceFsTestPath(betaPath)) {
          const error = new Error('missing beta') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }

        return originalWorkspaceFs.stat(uri);
      }
    } as typeof vscode.workspace.fs);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            debounceMs: 1,
            semanticEnrichment: false
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
      vscode.Uri.file(alphaPath),
      vscode.Uri.file(betaPath)
    ]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      if (typeof pathOrUri === 'string') {
        return pathOrUri;
      }

      return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: (listener: (uri: vscode.Uri) => void) => {
        onDidChange = listener;
        return new vscode.Disposable(() => {
          onDidChange = undefined;
        });
      },
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persistedWrites += 1;
        persistedSnapshot = snapshot;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => persistedWrites >= 1, 'initial missing-file watcher snapshot');
      assert.ok(onDidChange, 'watcher change handler should be registered');

      providerCalls.splice(0, providerCalls.length);
      failMissingBeta = true;
      await fs.rm(betaPath, { force: true });
      onDidChange?.(vscode.Uri.file(betaPath));

      await waitFor(
        () => persistedWrites >= 2 && persistedSnapshot?.fileIndex.some((entry) => entry.relativePath === 'src/beta.ts') === false,
        'missing-file watcher snapshot'
      );
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(configPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    assert.deepEqual(providerCalls, []);
    assert.equal(persistedSnapshot?.fileIndex.some((entry) => entry.relativePath === 'src/beta.ts'), false);
    assert.equal(persistedSnapshot?.merkle.leaves.some((leaf) => leaf.relativePath === 'src/beta.ts'), false);
    assert.equal(persistedSnapshot?.fileIndex.some((entry) => entry.relativePath === 'src/alpha.ts'), true);
  });

  test('yields while indexing a large workspace build', async function () {
    this.timeout(20000);
    const seedPath = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'large-workspace', 'seed.ts');
    const seedSource = await fs.readFile(seedPath, 'utf8');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-large-'));
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const sourceRoot = path.join(workspaceRoot, 'src');
    await fs.mkdir(sourceRoot, { recursive: true });

    const files: vscode.Uri[] = [];
    for (let index = 0; index < 500; index += 1) {
      const filePath = path.join(sourceRoot, `file-${index}.ts`);
      await fs.writeFile(filePath, seedSource.replace('seed', `seed${index}`), 'utf8');
      files.push(vscode.Uri.file(filePath));
    }

    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let scheduledYields = 0;
    const originalSetTimeout = globalThis.setTimeout;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file(workspaceRoot),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => undefined) as typeof vscode.window.showInputBox);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);
    const timeoutPatch = patchProperty(globalThis, 'setTimeout', (((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if ((delay ?? 0) === 0) {
        scheduledYields += 1;
      }

      return originalSetTimeout(callback, delay, ...args);
    }) as unknown) as typeof globalThis.setTimeout);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      await Promise.resolve(goToFileCommand?.());
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configPatch);
      restoreProperty(inputPatch);
      restoreProperty(executePatch);
      restoreProperty(timeoutPatch);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }

    assert.ok(scheduledYields >= 1, 'large workspace indexing should yield to the event loop');
  });

  test('shows indexing progress in the status bar during a large workspace build', async function () {
    this.timeout(20000);
    const seedPath = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'large-workspace', 'seed.ts');
    const seedSource = await fs.readFile(seedPath, 'utf8');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-progress-'));
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const sourceRoot = path.join(workspaceRoot, 'src');
    await fs.mkdir(sourceRoot, { recursive: true });

    const files: vscode.Uri[] = [];
    for (let index = 0; index < 125; index += 1) {
      const filePath = path.join(sourceRoot, `file-${index}.ts`);
      await fs.writeFile(filePath, seedSource.replace('seed', `seed${index}`), 'utf8');
      files.push(vscode.Uri.file(filePath));
    }

    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const statusUpdates: string[] = [];
    const visibilityEvents: string[] = [];

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const statusBarPatch = patchProperty(
      vscode.window,
      'createStatusBarItem',
      (((_alignment?: vscode.StatusBarAlignment, _priority?: number) =>
        createTrackedStatusBarItem(statusUpdates, visibilityEvents)) as unknown) as typeof vscode.window.createStatusBarItem
    );
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file(workspaceRoot),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => undefined) as typeof vscode.window.showInputBox);
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => []) as typeof vscode.commands.executeCommand);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      await Promise.resolve(goToFileCommand?.());
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(statusBarPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configPatch);
      restoreProperty(inputPatch);
      restoreProperty(executePatch);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }

    assert.ok(
      statusUpdates.some((update) => update.includes('scanning workspace')),
      'status bar should show the workspace scan phase'
    );
    assert.ok(
      statusUpdates.some((update) => /(indexing|rebuilding) \d+\/125/.test(update)),
      'status bar should show indexing progress counts'
    );
    assert.ok(
      visibilityEvents.includes('show'),
      'status bar progress should appear during indexing'
    );
  });

  test('semantic enrichment does not block initial snapshot persistence when providers are slow', async () => {
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const indexedFile = vscode.Uri.parse('file:///workspace/src/app/main.ts');
    let semanticProviderStarted = false;
    let persistedWrites = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [{
          name: 'TestSymbol',
          kind: 5,
          range: new vscode.Range(0, 0, 0, 10),
          selectionRange: new vscode.Range(0, 0, 0, 10),
          children: []
        }];
      }

      if (command === 'vscode.executeDefinitionProvider') {
        semanticProviderStarted = true;
        // Never resolve - simulating slow provider
        return new Promise(() => {});
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub({
      [indexedFile.fsPath]: 'export const main = 1;'
    }));
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: true,
            semanticConcurrency: 2,
            semanticTimeoutMs: 750
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persistedWrites += 1;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      // Wait for initial build and persistence to complete
      await waitFor(() => persistedWrites >= 1, 'initial snapshot persistence', 2000);

      // Assert that semantic provider started (enrichment began)
      await waitFor(() => semanticProviderStarted, 'semantic enrichment start', 2000);

      // Assert that persistence completed despite slow semantic provider
      assert.equal(persistedWrites >= 1, true, 'snapshot should be persisted even when semantic providers are slow');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }
  });

  test('times out slow document symbol providers during initial indexing and still persists the snapshot', async () => {
    const workspaceUri = vscode.Uri.file('c:\\workspace');
    const indexedFile = vscode.Uri.parse('file:///workspace/src/app/main.ts');
    const outputLines: string[] = [];
    let persistedWrites = 0;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: (value: string) => {
        outputLines.push(value);
      },
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return new Promise(() => {});
      }

      return [];
    }) as typeof vscode.commands.executeCommand);
    const workspaceFsPatch = patchProperty(vscode.workspace, 'fs', createWorkspaceFsStub({
      [indexedFile.fsPath]: 'export const main = 1;'
    }));
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            completionStyleResults: false,
            semanticEnrichment: false,
            symbolProviderTimeoutMs: 100
          };
          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async (_workspaceId, snapshot) => {
        if (!isCompleteLayerSnapshot(snapshot)) {
          return;
        }

        persistedWrites += 1;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => persistedWrites >= 1, 'initial snapshot persistence', 2000);
      await waitFor(
        () => outputLines.some((line) => line.includes('Timed out reading document symbols for src/app/main.ts')),
        'symbol timeout diagnostic',
        2000
      );
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(workspaceFsPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }

    assert.ok(
      outputLines.some((line) => line.includes('Timed out reading document symbols for src/app/main.ts')),
      'slow symbol providers should emit a timeout diagnostic'
    );
    assert.equal(persistedWrites >= 1, true, 'snapshot should be persisted even when symbol providers hang');
  });
});
