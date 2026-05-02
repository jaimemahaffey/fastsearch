import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activate, readEligibleTextContent } from '../../extension';
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
    assert.equal(findFilesCalls[0]?.exclude, '**/{node_modules,.git,.hg,.svn,dist,build,coverage,out,target}/**');
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

  test('keeps same-folder-name workspace entries distinct during the initial build', async () => {
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let quickPickItems: readonly { description?: string; }[] | undefined;
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
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'main') as typeof vscode.window.showInputBox);
    const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly { description?: string; }[]) => {
      quickPickItems = items;
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);

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
      restoreProperty(inputPatch);
      restoreProperty(quickPickPatch);
    }

    assert.equal(quickPickItems?.length, 2);
    assert.deepEqual(quickPickItems?.map((item) => item.description), [
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
});
