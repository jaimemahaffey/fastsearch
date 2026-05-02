import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { rebuildIndex } from '../../commands/rebuildIndex';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('rebuildIndex', () => {
  test('shows an error message when rebuilding the index fails', async () => {
    let shownMessage: string | undefined;

    const progressPatch = patchProperty(vscode.window, 'withProgress', (async (_options, task) => {
      await task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
    }) as typeof vscode.window.withProgress);
    const errorPatch = patchProperty(vscode.window, 'showErrorMessage', (async (message: string) => {
      shownMessage = message;
      return undefined;
    }) as typeof vscode.window.showErrorMessage);

    try {
      await rebuildIndex({
        rebuild: async () => {
          throw new Error('boom');
        }
      } as never);
    } finally {
      restoreProperty(progressPatch);
      restoreProperty(errorPatch);
    }

    assert.equal(shownMessage, 'Unable to rebuild Fast Symbol Index: boom');
  });
});
