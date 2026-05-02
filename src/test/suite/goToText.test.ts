import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { goToText } from '../../commands/goToText';
import { TextIndex } from '../../indexes/textIndex';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('goToText', () => {
  test('shows an error message when opening the selected text result fails', async () => {
    const index = new TextIndex();
    index.upsert(
      'src/app/main.ts',
      vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString(),
      'export const alpha = 1;\nexport const beta = alpha + 1;'
    );

    let errorMessage: string | undefined;
    let documentShown = false;

    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'beta') as typeof vscode.window.showInputBox);
    const pickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly {
      label: string;
      description?: string;
      match: { relativePath: string; uri: string; };
    }[]) => items[0]) as unknown) as typeof vscode.window.showQuickPick);
    const openPatch = patchProperty(vscode.workspace, 'openTextDocument', (async () => {
      throw new Error('open failed');
    }) as typeof vscode.workspace.openTextDocument);
    const errorPatch = patchProperty(vscode.window, 'showErrorMessage', (async (message: string) => {
      errorMessage = message;
      return undefined;
    }) as typeof vscode.window.showErrorMessage);
    const showPatch = patchProperty(vscode.window, 'showTextDocument', (async () => {
      documentShown = true;
      throw new Error('should not be called');
    }) as typeof vscode.window.showTextDocument);

    try {
      await goToText(index);
    } finally {
      restoreProperty(inputPatch);
      restoreProperty(pickPatch);
      restoreProperty(openPatch);
      restoreProperty(errorPatch);
      restoreProperty(showPatch);
    }

    assert.equal(documentShown, false);
    assert.equal(errorMessage, 'Unable to open indexed file: src/app/main.ts');
  });

  test('shows an informational message when the query has no indexed text matches', async () => {
    const index = new TextIndex();
    index.upsert(
      'src/app/main.ts',
      vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString(),
      'export const alpha = 1;'
    );

    let infoMessage: string | undefined;
    let quickPickShown = false;

    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'missing') as typeof vscode.window.showInputBox);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const pickPatch = patchProperty(vscode.window, 'showQuickPick', ((async () => {
      quickPickShown = true;
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);

    try {
      await goToText(index);
    } finally {
      restoreProperty(inputPatch);
      restoreProperty(infoPatch);
      restoreProperty(pickPatch);
    }

    assert.equal(quickPickShown, false);
    assert.equal(infoMessage, 'No indexed text matched "missing".');
  });
});
