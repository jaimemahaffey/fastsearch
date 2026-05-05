import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'jaimemahaffey.fastsearch';

suite('activation', () => {
  test('registers the required commands', async function () {
    this.timeout(10000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be available');

    if (!extension.isActive) {
      await assert.doesNotReject(
        () => Promise.resolve(extension.activate()),
        'extension should activate successfully'
      );
      assert.equal(extension.isActive, true, 'extension should be active after activation');
    }

    const commands = await vscode.commands.getCommands(true);

    for (const command of [
      'fastIndexer.cycleSearchMode',
      'fastIndexer.goToFile',
      'fastIndexer.goToSymbol',
      'fastIndexer.goToText',
      'fastIndexer.findUsages',
      'fastIndexer.findImplementations',
      'fastIndexer.rebuildIndex'
    ]) {
      assert.ok(commands.includes(command), `missing command: ${command}`);
    }
  });

  test('exposes persisted-index settings in the manifest', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be available');

    if (!extension.isActive) {
      await extension.activate();
    }

    const properties = extension.packageJSON?.contributes?.configuration?.properties ?? {};

    assert.ok(properties['fastIndexer.include']);
    assert.ok(properties['fastIndexer.exclude']);
    assert.ok(properties['fastIndexer.ignoreFiles']);
    assert.ok(properties['fastIndexer.sharedIgnoreFiles']);
    assert.ok(properties['fastIndexer.symbolFallback']);
    assert.ok(properties['fastIndexer.providerFallback']);
    assert.ok(properties['fastIndexer.fuzzySearch']);
    assert.ok(properties['fastIndexer.completionStyleResults']);
    assert.ok(properties['fastIndexer.useRipgrep']);
    assert.ok(properties['fastIndexer.useFzf']);
  });

  test('contributes the cycling command and Ctrl+T keybinding in the manifest', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension should be available');

    if (!extension.isActive) {
      await extension.activate();
    }

    const commands = extension.packageJSON?.contributes?.commands ?? [];
    const keybindings = extension.packageJSON?.contributes?.keybindings ?? [];

    assert.ok(
      commands.some((contribution: { command?: string; }) => contribution.command === 'fastIndexer.cycleSearchMode'),
      'expected fastIndexer.cycleSearchMode command contribution'
    );
    const cycleBindings = keybindings.filter((binding: { command?: string; key?: string; when?: string; }) =>
      binding.command === 'fastIndexer.cycleSearchMode' && binding.key === 'ctrl+t'
    );

    assert.deepEqual(
      cycleBindings.map((binding: { when?: string; }) => binding.when).sort(),
      ['editorTextFocus', 'inQuickInput', 'terminalFocus'],
      'expected Ctrl+T bindings for editor, custom quick input, and terminal focus'
    );
  });
});
