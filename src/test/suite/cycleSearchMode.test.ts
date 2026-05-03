import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activate } from '../../extension';
import { FakeQuickPick } from './helpers/fakeQuickPick';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

type RegisteredCommands = Map<string, (...args: unknown[]) => unknown>;

type CycleHarnessOptions = {
  symbolsAvailable?: boolean;
};

async function activateWithCycleHarness(
  quickPicks: Array<FakeQuickPick<vscode.QuickPickItem & { candidate?: unknown; }>>,
  options: CycleHarnessOptions = {}
): Promise<{
  registeredCommands: RegisteredCommands;
  infoMessages: string[];
  restore(): void;
}> {
  const registeredCommands: RegisteredCommands = new Map();
  const infoMessages: string[] = [];
  const quickPickQueue = [...quickPicks];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fastsearch-cycle-'));
  const tempFile = path.join(tempRoot, 'src', 'app', 'main.ts');
  fs.mkdirSync(path.dirname(tempFile), { recursive: true });
  fs.writeFileSync(tempFile, 'const alpha = beta;\n', 'utf8');
  const patches = [
    patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
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
      vscode.Uri.file(tempFile)
    ]) as typeof vscode.workspace.findFiles),
    patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath),
    patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: vscode.Uri.file(tempRoot),
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
    patchProperty(vscode.commands, 'executeCommand', (async <T>(command: string) => {
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
