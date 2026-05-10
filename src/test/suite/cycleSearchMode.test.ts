import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PersistenceStore } from '../../core/persistenceStore';
import { activate } from '../../extension';
import { FakeQuickPick } from './helpers/fakeQuickPick';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

type RegisteredCommands = Map<string, (...args: unknown[]) => unknown>;

type CycleHarnessOptions = {
  symbolsAvailable?: boolean;
};

function toCyclePersistenceConfigHash(): string {
  return JSON.stringify({
    include: ['**/*'],
    exclude: [],
    ignoreFiles: [],
    sharedIgnoreFiles: [],
    ignoreInputs: [],
    maxFileSizeKb: 512,
    semanticEnrichment: true,
    semanticConcurrency: 2,
    semanticTimeoutMs: 750,
    symbolProviderTimeoutMs: 3000
  });
}

async function activateWithCycleHarness(
  quickPicks: Array<FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>>,
  options: CycleHarnessOptions = {}
): Promise<{
  registeredCommands: RegisteredCommands;
  infoMessages: string[];
  outputLines: string[];
  contextUpdates: Array<{ key: string; value: boolean; }>;
  restore(): void;
}> {
  const registeredCommands: RegisteredCommands = new Map();
  const infoMessages: string[] = [];
  const outputLines: string[] = [];
  const contextUpdates: Array<{ key: string; value: boolean; }> = [];
  const quickPickQueue = [...quickPicks];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsearch-cycle-'));
  const tempFile = path.join(tempRoot, 'src', 'app', 'main.ts');
  const workspaceUri = vscode.Uri.file(tempRoot);
  const tempFileUri = vscode.Uri.file(tempFile);
  fs.mkdirSync(path.dirname(tempFile), { recursive: true });
  fs.writeFileSync(tempFile, 'const alpha = beta;\n', 'utf8');
  const patches = [
    patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: (line: string) => {
        outputLines.push(line);
      },
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel),
    patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => {
        registeredCommands.delete(command);
      });
    }) as typeof vscode.commands.registerCommand),
    patchProperty(vscode.window, 'createQuickPick', ((() => {
      const quickPick = quickPickQueue.shift();
      assert.ok(quickPick, 'expected a fake quick pick for this invocation');
      return quickPick;
    }) as unknown) as typeof vscode.window.createQuickPick),
    patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessages.push(message);
      return undefined;
    }) as typeof vscode.window.showInformationMessage),
    patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: true,
            include: ['**/*'],
            exclude: [],
            debounceMs: 25,
            maxFileSizeKb: 512,
            completionStyleResults: true,
            fuzzySearch: true,
            useRipgrep: false,
            useFzf: false
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration),
    patchProperty(vscode.workspace, 'findFiles', (async () => [
      tempFileUri
    ]) as typeof vscode.workspace.findFiles),
    patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath),
    patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }]),
    patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    })) as typeof vscode.workspace.getWorkspaceFolder),
    patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher),
    patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration),
    patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => ({
        metadata: {
          schemaVersion: 2,
          workspaceId: encodeURIComponent(workspaceUri.toString()),
          configHash: toCyclePersistenceConfigHash()
        },
        merkle: {
          rootHash: '',
          subtreeHashes: [],
          leaves: []
        },
        fileIndex: [{
          relativePath: 'src/app/main.ts',
          uri: tempFileUri.toString(),
          basename: 'main.ts',
          extension: '.ts',
          tokens: ['src', 'app', 'main', 'ts']
        }],
        textIndex: [{
          relativePath: 'src/app/main.ts',
          uri: tempFileUri.toString(),
          content: 'const alpha = beta;\n',
          contentHash: 'alpha-hash'
        }],
        symbolIndex: [{
          relativePath: 'src/app/main.ts',
          contentHash: 'alpha-hash',
          symbols: options.symbolsAvailable === false
            ? []
            : [{
              name: 'AlphaService',
              kind: vscode.SymbolKind.Class,
              containerName: undefined,
              uri: tempFileUri.toString(),
              startLine: 1,
              startColumn: 2,
              approximate: false
            }]
        }]
      })) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    ),
    patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    ),
    patchProperty(vscode.commands, 'executeCommand', (async <T>(command: string, ...args: unknown[]) => {
      if (command === 'setContext') {
        contextUpdates.push({
          key: String(args[0]),
          value: Boolean(args[1])
        });
        return undefined as T;
      }

      if (command === 'vscode.executeDocumentSymbolProvider') {
        if (options.symbolsAvailable === false) {
          return [] as T;
        }

        const range = new vscode.Range(new vscode.Position(1, 2), new vscode.Position(1, 12));
        return [new vscode.DocumentSymbol('AlphaService', '', vscode.SymbolKind.Class, range, range)] as T;
      }

      return undefined as T;
    }) as typeof vscode.commands.executeCommand)
  ];
  const restoreAll = (): void => {
    for (const quickPick of quickPicks) {
      if (quickPick.showed && !quickPick.disposed) {
        quickPick.hide();
      }
    }

    for (const patch of [...patches].reverse()) {
      restoreProperty(patch as never);
    }

    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    activate({
      subscriptions: []
    } as unknown as vscode.ExtensionContext);
    await Promise.resolve();
    await Promise.resolve();

      return {
        registeredCommands,
        infoMessages,
        outputLines,
        contextUpdates,
        restore: restoreAll
      };
  } catch (error) {
    restoreAll();
    throw error;
  }
}

suite('cycleSearchMode', () => {
  test('cycles symbol, text, and file modes while the picker stays active', async () => {
    const quickPicks = [
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>()
    ];
    const harness = await activateWithCycleHarness(quickPicks);

    try {
      const cycleCommand = harness.registeredCommands.get('fastIndexer.cycleSearchMode');
      assert.ok(cycleCommand, 'cycleSearchMode command should be registered');

      await Promise.resolve(cycleCommand?.());
      assert.equal(quickPicks[0].title, 'Fast Indexer: Symbol Mode');
      assert.equal(quickPicks[0].placeholder, 'Search indexed symbols (symbol mode)');

      await Promise.resolve(cycleCommand?.());
      assert.equal(quickPicks[0].disposed, true);
      assert.equal(quickPicks[1].title, 'Fast Indexer: Text Mode');
      assert.equal(quickPicks[1].placeholder, 'Search indexed text (text mode)');

      await Promise.resolve(cycleCommand?.());
      assert.equal(quickPicks[1].disposed, true);
      assert.equal(quickPicks[2].title, 'Fast Indexer: File Mode');
      assert.equal(quickPicks[2].placeholder, 'Search indexed files (file mode)');
    } finally {
      harness.restore();
    }
  });

  test('logs cycle command transitions and picker replacement lifecycle', async () => {
    const quickPicks = [
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>()
    ];
    const harness = await activateWithCycleHarness(quickPicks);

    try {
      const cycleCommand = harness.registeredCommands.get('fastIndexer.cycleSearchMode');
      assert.ok(cycleCommand, 'cycleSearchMode command should be registered');

      await Promise.resolve(cycleCommand?.());
      await Promise.resolve(cycleCommand?.());

      assert.deepEqual(
        harness.outputLines.filter((line) => line.startsWith('[cycle]')),
        [
          '[cycle] command invoked',
          '[cycle] executing mode=symbol previousMode=none',
          '[cycle] opening picker title="Fast Indexer: Symbol Mode"',
          '[cycle] context fastIndexer.cyclePickerActive=true',
          '[cycle] picker shown title="Fast Indexer: Symbol Mode"',
          '[cycle] picker items updated title="Fast Indexer: Symbol Mode" query="" count=1',
          '[cycle] mode=symbol opened=true',
          '[cycle] command invoked',
          '[cycle] executing mode=text previousMode=symbol',
          '[cycle] opening picker title="Fast Indexer: Text Mode"',
          '[cycle] replacing active picker title="Fast Indexer: Symbol Mode"',
          '[cycle] picker hidden title="Fast Indexer: Symbol Mode" suppressHideHandler=true',
          '[cycle] context fastIndexer.cyclePickerActive=false',
          '[cycle] picker hide handler suppressed title="Fast Indexer: Symbol Mode"',
          '[cycle] context fastIndexer.cyclePickerActive=true',
          '[cycle] picker shown title="Fast Indexer: Text Mode"',
          '[cycle] picker items updated title="Fast Indexer: Text Mode" query="" count=0',
          '[cycle] mode=text opened=true'
        ]
      );
    } finally {
      harness.restore();
    }
  });

  test('sets a dedicated cycle picker keybinding context while the cycle picker is active', async () => {
    const quickPicks = [
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>()
    ];
    const harness = await activateWithCycleHarness(quickPicks);

    try {
      const cycleCommand = harness.registeredCommands.get('fastIndexer.cycleSearchMode');
      assert.ok(cycleCommand, 'cycleSearchMode command should be registered');

      await Promise.resolve(cycleCommand?.());
      quickPicks[0].hide();
      await Promise.resolve(cycleCommand?.());

      assert.deepEqual(harness.contextUpdates, [
        { key: 'fastIndexer.cyclePickerActive', value: true },
        { key: 'fastIndexer.cyclePickerActive', value: false },
        { key: 'fastIndexer.cyclePickerActive', value: true }
      ]);
    } finally {
      harness.restore();
    }
  });

  test('resets the cycle back to symbol mode after the active picker hides', async () => {
    const quickPicks = [
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>()
    ];
    const harness = await activateWithCycleHarness(quickPicks);

    try {
      const cycleCommand = harness.registeredCommands.get('fastIndexer.cycleSearchMode');
      assert.ok(cycleCommand, 'cycleSearchMode command should be registered');

      await Promise.resolve(cycleCommand?.());
      quickPicks[0].hide();

      await Promise.resolve(cycleCommand?.());
      assert.equal(quickPicks[1].title, 'Fast Indexer: Symbol Mode');
      assert.equal(quickPicks[1].placeholder, 'Search indexed symbols (symbol mode)');
    } finally {
      harness.restore();
    }
  });

  test('resets back to symbol mode after closing the second cycle picker', async () => {
    const quickPicks = [
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>()
    ];
    const harness = await activateWithCycleHarness(quickPicks);

    try {
      const cycleCommand = harness.registeredCommands.get('fastIndexer.cycleSearchMode');
      assert.ok(cycleCommand, 'cycleSearchMode command should be registered');

      await Promise.resolve(cycleCommand?.());
      await Promise.resolve(cycleCommand?.());
      quickPicks[1].hide();

      await Promise.resolve(cycleCommand?.());
      assert.equal(quickPicks[2].title, 'Fast Indexer: Symbol Mode');
      assert.equal(quickPicks[2].placeholder, 'Search indexed symbols (symbol mode)');
    } finally {
      harness.restore();
    }
  });

  test('resets the cycle after a dedicated command replaces the active cycle picker', async () => {
    const quickPicks = [
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>(),
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>()
    ];
    const harness = await activateWithCycleHarness(quickPicks);

    try {
      const cycleCommand = harness.registeredCommands.get('fastIndexer.cycleSearchMode');
      const goToFileCommand = harness.registeredCommands.get('fastIndexer.goToFile');
      assert.ok(cycleCommand, 'cycleSearchMode command should be registered');
      assert.ok(goToFileCommand, 'goToFile command should be registered');

      await Promise.resolve(cycleCommand?.());
      await Promise.resolve(cycleCommand?.());
      await Promise.resolve(goToFileCommand?.());
      await Promise.resolve(cycleCommand?.());

      assert.equal(quickPicks[3].title, 'Fast Indexer: Symbol Mode');
      assert.equal(quickPicks[3].placeholder, 'Search indexed symbols (symbol mode)');
    } finally {
      harness.restore();
    }
  });

  test('does not advance the cycle when the active mode exits before showing a picker', async () => {
    const quickPicks = [
      new FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>()
    ];
    const harness = await activateWithCycleHarness(quickPicks, { symbolsAvailable: false });

    try {
      const cycleCommand = harness.registeredCommands.get('fastIndexer.cycleSearchMode');
      assert.ok(cycleCommand, 'cycleSearchMode command should be registered');

      await Promise.resolve(cycleCommand?.());
      await Promise.resolve(cycleCommand?.());

      assert.deepEqual(harness.infoMessages.filter((message) => message === 'No indexed symbols are available yet.'), [
        'No indexed symbols are available yet.',
        'No indexed symbols are available yet.'
      ]);
      assert.equal(quickPicks[0].showed, false);
    } finally {
      harness.restore();
    }
  });
});
