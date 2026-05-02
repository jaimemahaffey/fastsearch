import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('activation', () => {
  test('registers the required commands', async () => {
    const extension = vscode.extensions.getExtension('local.fast-symbol-indexer');
    assert.ok(extension, 'extension should be available');

    if (!extension.isActive) {
      await assert.doesNotReject(
        () => Promise.resolve(vscode.commands.executeCommand('fastIndexer.goToFile')),
        'goToFile should activate the extension'
      );
      assert.equal(extension.isActive, true, 'extension should be active after command execution');
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
});
