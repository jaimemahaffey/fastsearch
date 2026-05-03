import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activate, readEligibleTextContent } from '../../extension';
import { FakeQuickPick } from './helpers/fakeQuickPick';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('extension activation', () => {
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
    assert.equal(findFilesCalls[0]?.exclude, '{**/{node_modules,.git,.hg,.svn,dist,build,coverage,out,target}/**,**/node_modules/**,**/.git/**}');
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

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      restoreProperty(outputPatch);
      restoreProperty(registerPatch);
      restoreProperty(configPatch);
      restoreProperty(findFilesPatch);
      restoreProperty(watcherPatch);
      restoreProperty(configListenerPatch);
    }

    assert.deepEqual(findFilesCalls, [
      {
        include: '{src/**/*.ts,lib/**/*.ts}',
        exclude: '{**/{node_modules,.git,.hg,.svn,dist,build,coverage,out,target}/**,**/*.snap}'
      }
    ]);
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

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToFileCommand = registeredCommands.get('fastIndexer.goToFile');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      const commandPromise = Promise.resolve(goToFileCommand?.());
      await Promise.resolve();

      assert.equal(infoMessage, 'Building initial indexes. Please wait a moment.');
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

    try {
      activate({
        subscriptions: []
      } as unknown as vscode.ExtensionContext);

      const goToTextCommand = registeredCommands.get('fastIndexer.goToText');
      assert.ok(goToTextCommand, 'goToText command should be registered');

      const commandPromise = Promise.resolve(goToTextCommand?.());
      await Promise.resolve();

      assert.equal(infoMessage, 'Building initial indexes. Please wait a moment.');
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
      await Promise.resolve();

      assert.equal(infoMessage, 'Building initial indexes. Please wait a moment.');
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
});
