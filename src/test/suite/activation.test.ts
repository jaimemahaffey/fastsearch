import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('activation', () => {
  test('registers the required commands', async function () {
    this.timeout(10000);
    const extension = vscode.extensions.getExtension('local.fast-symbol-indexer');
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
    const extension = vscode.extensions.getExtension('local.fast-symbol-indexer');
    assert.ok(extension, 'extension should be available');

    if (!extension.isActive) {
      await extension.activate();
    }

    const properties = extension.packageJSON?.contributes?.configuration?.properties ?? {};

    assert.ok(properties['fastIndexer.include']);
    assert.ok(properties['fastIndexer.exclude']);
    assert.ok(properties['fastIndexer.symbolFallback']);
    assert.ok(properties['fastIndexer.providerFallback']);
  });
});
