import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { goToSymbol } from '../../commands/goToSymbol';
import { SymbolIndex } from '../../indexes/symbolIndex';
import { FakeQuickPick } from './helpers/fakeQuickPick';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('goToSymbol', () => {
  test('uses a completion-style picker that narrows symbol matches and preserves metadata', async () => {
    const index = new SymbolIndex();
    index.replaceForFile('src/app/main.ts', [
      {
        name: 'MainGraphRenderer',
        kind: vscode.SymbolKind.Class,
        containerName: 'Graph',
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString(),
        startLine: 4,
        startColumn: 2,
        approximate: false
      },
      {
        name: 'MainTextRenderer',
        kind: vscode.SymbolKind.Class,
        containerName: 'Text',
        uri: vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString(),
        startLine: 14,
        startColumn: 2,
        approximate: true
      }
    ]);

    const quickPick = new FakeQuickPick<vscode.QuickPickItem & {
      symbol: { uri: string; startLine: number; startColumn: number; name: string; };
    }>();
    let selectedPosition: vscode.Position | undefined;

    const pickerPatch = patchProperty(vscode.window, 'createQuickPick', ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick);
    const openPatch = patchProperty(vscode.workspace, 'openTextDocument', ((async (uri: vscode.Uri) => ({ uri } as vscode.TextDocument)) as unknown) as typeof vscode.workspace.openTextDocument);
    const showPatch = patchProperty(vscode.window, 'showTextDocument', (async () => ({
      selection: undefined,
      revealRange: (range: vscode.Range) => {
        selectedPosition = range.start;
      }
    }) as unknown as vscode.TextEditor) as typeof vscode.window.showTextDocument);

    try {
      await goToSymbol(index, { completionStyleResults: true, fuzzySearch: true });

      assert.equal(quickPick.showed, true);
      assert.deepEqual(quickPick.items.map((item) => item.label), [
        'MainGraphRenderer',
        'MainTextRenderer'
      ]);

      const narrowedItems = quickPick.waitForItemsUpdate();
      quickPick.fireChangeValue('mgr');
      await narrowedItems;

      assert.deepEqual(quickPick.items.map((item) => item.label), ['MainGraphRenderer']);
      assert.equal(quickPick.items[0]?.description, 'Graph');
      assert.equal(quickPick.items[0]?.detail, vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').fsPath);
      assert.equal((quickPick.items[0]?.iconPath as vscode.ThemeIcon | undefined)?.id, 'circle-filled');

      quickPick.selectedItems = [quickPick.items[0]!];
      quickPick.fireAccept();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      restoreProperty(pickerPatch);
      restoreProperty(openPatch);
      restoreProperty(showPatch);
    }

    assert.deepEqual(selectedPosition, new vscode.Position(4, 2));
    assert.equal(quickPick.disposed, true);
  });

  test('labels completion results as partial while preserving existing details', async () => {
    const index = new SymbolIndex();
    const symbolUri = vscode.Uri.file('c:\\workspace\\src\\app\\main.ts');
    index.replaceForFile('src/app/main.ts', [
      {
        name: 'MainGraphRenderer',
        kind: vscode.SymbolKind.Class,
        containerName: 'Graph',
        uri: symbolUri.toString(),
        startLine: 4,
        startColumn: 2,
        approximate: false
      }
    ]);

    const quickPick = new FakeQuickPick<vscode.QuickPickItem>();
    const pickerPatch = patchProperty(vscode.window, 'createQuickPick', ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick);

    try {
      await goToSymbol(
        index,
        { completionStyleResults: true, fuzzySearch: true },
        {},
        { partialResultsMessage: 'Partial symbol index; background hydration is still running.' }
      );

      assert.equal(quickPick.showed, true);
      assert.equal(quickPick.items.length, 1);
      assert.equal(quickPick.items[0]?.label, 'MainGraphRenderer');
      assert.equal(quickPick.items[0]?.description, 'Graph');
      assert.equal(
        quickPick.items[0]?.detail,
        `${symbolUri.fsPath} \u00B7 Partial symbol index; background hydration is still running.`
      );
      assert.equal((quickPick.items[0]?.iconPath as vscode.ThemeIcon | undefined)?.id, 'circle-filled');
    } finally {
      restoreProperty(pickerPatch);
    }
  });

});
