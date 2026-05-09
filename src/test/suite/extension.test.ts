import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { IndexCoordinator } from '../../core/indexCoordinator';
import { PersistenceStore } from '../../core/persistenceStore';
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

suite('extension activation', () => {
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
    const quickPickPatch = patchProperty(vscode.window, 'createQuickPick', ((() => {
      const quickPick = new FakeQuickPick<vscode.QuickPickItem & { description?: string; }>();
      quickPicks.push(quickPick);
      return quickPick;
    }) as unknown) as typeof vscode.window.createQuickPick);
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
      stat: async () => {
        await textLayerReady;
        return {
          type: vscode.FileType.File,
          ctime: 0,
          mtime: 0,
          size: 64
        };
      },
      readFile: async () => Uint8Array.from(Buffer.from('export const value = 1;'))
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
      restoreProperty(fsPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(configPatch);
      restoreProperty(executePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(infoPatch);
      restoreProperty(registerPatch);
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
      (async () => {
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

  test('shows a warming notice before waiting for the initial symbol index build', async function () {
    this.timeout(7000);
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const quickPicks: Array<FakeQuickPick<vscode.QuickPickItem & { description?: string; }>> = [];
    let infoMessage: string | undefined;
    let symbolRelease: (() => void) | undefined;
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
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [vscode.Uri.file('c:\\workspace\\src\\app\\main.ts')]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file('c:\\workspace'),
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const quickPickPatch = patchProperty(vscode.window, 'createQuickPick', ((() => {
      const quickPick = new FakeQuickPick<vscode.QuickPickItem & { description?: string; }>();
      quickPicks.push(quickPick);
      return quickPick;
    }) as unknown) as typeof vscode.window.createQuickPick);
    const fsPatch = patchProperty(vscode.workspace, 'fs', {
      ...originalWorkspaceFs,
      stat: async () => ({
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: 64
      }),
      readFile: async () => Uint8Array.from(Buffer.from('export const value = 1;'))
    } as typeof vscode.workspace.fs);
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
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        await new Promise<void>((resolve) => {
          symbolRelease = resolve;
        });
        return [
          new vscode.DocumentSymbol(
            'mainSymbol',
            '',
            vscode.SymbolKind.Function,
            new vscode.Range(0, 0, 0, 10),
            new vscode.Range(0, 0, 0, 10)
          )
        ];
      }
      return [];
    }) as typeof vscode.commands.executeCommand);

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToSymbolCommand = registeredCommands.get('fastIndexer.goToSymbol');
      assert.ok(goToSymbolCommand, 'goToSymbol command should be registered');

      const commandPromise = Promise.resolve(goToSymbolCommand?.());
      await waitFor(() => infoMessage !== undefined, 'symbol warming notice');

      assert.equal(infoMessage, 'Building initial symbol index. Please wait a moment.');
      assert.equal(quickPicks.length, 0);
      const beforeReleaseOutcome = await Promise.race([
        commandPromise.then(() => 'resolved'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20))
      ]);
      assert.equal(beforeReleaseOutcome, 'waiting');

      await waitFor(() => symbolRelease !== undefined, 'symbol index phase to start');
      symbolRelease?.();
      await commandPromise;
    } finally {
      symbolRelease?.();
      restoreProperty(outputPatch);
      restoreProperty(infoPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(quickPickPatch);
      restoreProperty(fsPatch);
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(executePatch);
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

  test('ignores watcher updates from excluded heavy paths', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let onDidCreate: ((uri: vscode.Uri) => void) | undefined;
    let scheduledRefreshes = 0;

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

      const excludedTimeoutPatch = patchProperty(globalThis, 'setTimeout', (((callback: (...args: unknown[]) => void) => {
        scheduledRefreshes += 1;
        callback();
        return {} as NodeJS.Timeout;
      }) as unknown) as typeof globalThis.setTimeout);
      onDidCreate?.(vscode.Uri.file('c:\\workspace\\node_modules\\pkg\\index.js'));
      restoreProperty(excludedTimeoutPatch);

      assert.equal(scheduledRefreshes, 0);

      const includedTimeoutPatch = patchProperty(globalThis, 'setTimeout', (((callback: (...args: unknown[]) => void) => {
        scheduledRefreshes += 1;
        callback();
        return {} as NodeJS.Timeout;
      }) as unknown) as typeof globalThis.setTimeout);
      onDidCreate?.(vscode.Uri.file('c:\\workspace\\src\\app\\main.ts'));
      restoreProperty(includedTimeoutPatch);

      assert.equal(scheduledRefreshes, 1);
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(relativePatch);
      restoreProperty(workspaceFolderPatch);
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
      (async () => {
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
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => {
        persistedWrites += 1;
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');
      await Promise.resolve(goToFileCommand?.());
      await waitFor(() => persistedWrites >= 1, 'workspace snapshot persistence');
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
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
      statusUpdates.some((update) => /(indexing|rebuilding) file \d+\/125/.test(update)),
      'status bar should show file-layer progress counts'
    );
    assert.ok(
      statusUpdates.some((update) => /(indexing|rebuilding) text \d+\/125/.test(update)),
      'status bar should show text-layer progress counts'
    );
    assert.ok(
      statusUpdates.some((update) => /(indexing|rebuilding) symbol \d+\/125/.test(update)),
      'status bar should show symbol-layer progress counts'
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
      (async () => { persistedWrites += 1; }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      // Wait for initial build and persistence to complete
      await waitFor(() => persistedWrites === 1, 'initial snapshot persistence', 2000);

      // Assert that semantic provider started (enrichment began)
      assert.ok(semanticProviderStarted, 'semantic enrichment should have started');

      // Assert that persistence completed despite slow semantic provider
      assert.equal(persistedWrites, 1, 'snapshot should be persisted even when semantic providers are slow');
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
      (async () => { persistedWrites += 1; }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      await waitFor(() => persistedWrites === 1, 'initial snapshot persistence', 2000);
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
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
    }

    assert.ok(
      outputLines.some((line) => line.includes('Timed out reading document symbols for src/app/main.ts')),
      'slow symbol providers should emit a timeout diagnostic'
    );
    assert.equal(persistedWrites, 1, 'snapshot should be persisted even when symbol providers hang');
  });
});
