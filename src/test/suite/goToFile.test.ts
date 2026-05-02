import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { goToFile } from '../../commands/goToFile';
import { FileIndex } from '../../indexes/fileIndex';

type RestorableProperty<T extends object, K extends keyof T> = {
  target: T;
  key: K;
  descriptor: PropertyDescriptor | undefined;
};

function patchProperty<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K]
): RestorableProperty<T, K> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value
  });
  return { target, key, descriptor };
}

function restoreProperty<T extends object, K extends keyof T>(restorable: RestorableProperty<T, K>): void {
  if (restorable.descriptor) {
    Object.defineProperty(restorable.target, restorable.key, restorable.descriptor);
    return;
  }

  delete restorable.target[restorable.key];
}

suite('goToFile', () => {
  test('shows an informational message when no indexed files are available', async () => {
    const index = new FileIndex();
    let infoMessage: string | undefined;
    let inputPrompted = false;

    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => {
      inputPrompted = true;
      return undefined;
    }) as typeof vscode.window.showInputBox);

    try {
      await goToFile(index);
    } finally {
      restoreProperty(infoPatch);
      restoreProperty(inputPatch);
    }

    assert.equal(infoMessage, 'No indexed files are available yet.');
    assert.equal(inputPrompted, false);
  });

  test('shows an error message when opening the selected file fails', async () => {
    const index = new FileIndex();
    index.upsert('src/app/main.ts', vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString());

    let errorMessage: string | undefined;
    let documentShown = false;

    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'main') as typeof vscode.window.showInputBox);
    const pickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly {
      label: string;
      description?: string;
      entry: { relativePath: string; uri: string; };
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
      await goToFile(index);
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
});
