import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { goToFile } from '../../commands/goToFile';
import { FileIndex } from '../../indexes/fileIndex';
import { FakeQuickPick } from './helpers/fakeQuickPick';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

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
      await goToFile(index, { completionStyleResults: false, fuzzySearch: true });
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
      await goToFile(index, { completionStyleResults: false, fuzzySearch: true });
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

  test('shows an informational message when the query has no indexed matches', async () => {
    const index = new FileIndex();
    index.upsert('src/app/main.ts', vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString());

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
      await goToFile(index, { completionStyleResults: false, fuzzySearch: true });
    } finally {
      restoreProperty(inputPatch);
      restoreProperty(infoPatch);
      restoreProperty(pickPatch);
    }

    assert.equal(quickPickShown, false);
    assert.equal(infoMessage, 'No indexed files matched "missing".');
  });

  test('uses a completion-style picker that narrows fuzzy-ranked file results', async () => {
    const index = new FileIndex();
    index.upsert('src/app/go-to-file.ts', vscode.Uri.file('c:\\workspace\\src\\app\\go-to-file.ts').toString());
    index.upsert('src/app/go-to-text.ts', vscode.Uri.file('c:\\workspace\\src\\app\\go-to-text.ts').toString());

    const quickPick = new FakeQuickPick<vscode.QuickPickItem & { entry: { relativePath: string; uri: string; }; }>();
    let openedUri: string | undefined;
    let documentShown = false;

    const pickerPatch = patchProperty(vscode.window, 'createQuickPick', ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick);
    const openPatch = patchProperty(vscode.workspace, 'openTextDocument', ((async (uri: vscode.Uri) => {
      openedUri = uri.toString();
      return { uri } as vscode.TextDocument;
    }) as unknown) as typeof vscode.workspace.openTextDocument);
    const showPatch = patchProperty(vscode.window, 'showTextDocument', (async () => {
      documentShown = true;
      return {} as vscode.TextEditor;
    }) as typeof vscode.window.showTextDocument);

    try {
      await goToFile(index, { completionStyleResults: true, fuzzySearch: true });

      assert.equal(quickPick.showed, true);
      assert.deepEqual(quickPick.items.map((item) => item.label), [
        'go-to-file.ts',
        'go-to-text.ts'
      ]);

      const narrowedItems = quickPick.waitForItemsUpdate();
      quickPick.fireChangeValue('gtf');
      await narrowedItems;

      assert.deepEqual(quickPick.items.map((item) => item.label), ['go-to-file.ts']);
      assert.equal(quickPick.items[0]?.description, 'src/app/go-to-file.ts');
      assert.equal(quickPick.items[0]?.detail, 'Indexed file');

      quickPick.selectedItems = [quickPick.items[0]!];
      quickPick.fireAccept();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      restoreProperty(pickerPatch);
      restoreProperty(openPatch);
      restoreProperty(showPatch);
    }

    assert.equal(openedUri, vscode.Uri.file('c:\\workspace\\src\\app\\go-to-file.ts').toString());
    assert.equal(documentShown, true);
    assert.equal(quickPick.disposed, true);
  });

  test('uses fzf to refine completion-style file results without replacing Quick Pick', async () => {
    const index = new FileIndex();
    index.upsert('src/app/go-to-file.ts', vscode.Uri.file('c:\\workspace\\src\\app\\go-to-file.ts').toString());
    index.upsert('src/app/go-to-text.ts', vscode.Uri.file('c:\\workspace\\src\\app\\go-to-text.ts').toString());

    const quickPick = new FakeQuickPick<vscode.QuickPickItem & { entry: { relativePath: string; uri: string; }; }>();
    const pickerPatch = patchProperty(vscode.window, 'createQuickPick', ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick);

    try {
      await goToFile(
        index,
        { completionStyleResults: true, fuzzySearch: true, useFzf: true },
        {
          toolRunner: async () => ({
            exitCode: 0,
            stdout: [
              '1\tgo to text src/app/go-to-text.ts',
              '0\tgo to file src/app/go-to-file.ts'
            ].join('\n'),
            stderr: ''
          })
        }
      );

      assert.equal(quickPick.showed, true);

      const narrowedItems = quickPick.waitForItemsUpdate();
      quickPick.fireChangeValue('gt');
      await narrowedItems;

      assert.deepEqual(quickPick.items.map((item) => item.label), [
        'go-to-text.ts',
        'go-to-file.ts'
      ]);
    } finally {
      restoreProperty(pickerPatch);
    }
  });
});
