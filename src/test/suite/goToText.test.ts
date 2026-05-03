import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { goToText } from '../../commands/goToText';
import { TextIndex } from '../../indexes/textIndex';
import { FakeQuickPick } from './helpers/fakeQuickPick';
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
      await goToText(index, { completionStyleResults: false, fuzzySearch: true });
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
      await goToText(index, { completionStyleResults: false, fuzzySearch: true });
    } finally {
      restoreProperty(inputPatch);
      restoreProperty(infoPatch);
      restoreProperty(pickPatch);
    }

    assert.equal(quickPickShown, false);
    assert.equal(infoMessage, 'No indexed text matched "missing".');
  });

  test('uses a completion-style picker with live text previews and navigation', async () => {
    const index = new TextIndex();
    index.upsert(
      'src/app/main.ts',
      vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString(),
      'export const alpha = 1;\nexport const beta = alpha + 1;'
    );

    const quickPick = new FakeQuickPick<vscode.QuickPickItem & {
      match: { relativePath: string; uri: string; line: number; column: number; };
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
      await goToText(index, { completionStyleResults: true, fuzzySearch: true });

      assert.equal(quickPick.showed, true);

      const narrowedItems = quickPick.waitForItemsUpdate();
      quickPick.fireChangeValue('beta');
      await narrowedItems;

      const items = [...quickPick.items];

      assert.deepEqual(items.map((item) => item.label), ['src/app/main.ts:2']);
      assert.equal(items[0]?.description, 'export const beta = alpha + 1;');
      assert.equal(items[0]?.detail, 'Line 2, Column 14');

      quickPick.selectedItems = [quickPick.items[0]!];
      quickPick.fireAccept();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      restoreProperty(pickerPatch);
      restoreProperty(openPatch);
      restoreProperty(showPatch);
    }

    assert.deepEqual(selectedPosition, new vscode.Position(1, 13));
    assert.equal(quickPick.disposed, true);
  });

  test('uses ripgrep candidates when enabled to gather text matches beyond the local index', async () => {
    const index = new TextIndex();
    index.upsert(
      'src/app/main.ts',
      vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString(),
      'export const alpha = 1;'
    );

    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [
      {
        uri: vscode.Uri.file('c:\\workspace'),
        index: 0,
        name: 'workspace'
      }
    ] as typeof vscode.workspace.workspaceFolders);
    const relativePathPatch = patchProperty(vscode.workspace, 'asRelativePath', ((resource: string | vscode.Uri) => {
      return typeof resource === 'string' ? resource : 'src/external.ts';
    }) as typeof vscode.workspace.asRelativePath);

    let pickedLabels: string[] | undefined;
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'gamma') as typeof vscode.window.showInputBox);
    const pickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly { label: string; }[]) => {
      pickedLabels = items.map((item) => item.label);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);

    try {
      await goToText(
        index,
        { completionStyleResults: false, fuzzySearch: true, useRipgrep: true, useFzf: false },
        {
          toolRunner: async () => ({
            exitCode: 0,
            stdout: `${JSON.stringify({
              type: 'match',
              data: {
                path: { text: 'c:\\workspace\\src\\external.ts' },
                lines: { text: 'export const gamma = alpha + 1;\n' },
                line_number: 4,
                submatches: [{ start: 13, end: 18, match: { text: 'gamma' } }]
              }
            })}\n`,
            stderr: ''
          })
        }
      );
    } finally {
      restoreProperty(pickPatch);
      restoreProperty(inputPatch);
      restoreProperty(relativePathPatch);
      restoreProperty(workspaceFoldersPatch);
    }

    assert.deepEqual(pickedLabels, ['src/external.ts:4']);
  });

  test('falls back to indexed text results when ripgrep is unavailable', async () => {
    const index = new TextIndex();
    index.upsert(
      'src/app/main.ts',
      vscode.Uri.file('c:\\workspace\\src\\app\\main.ts').toString(),
      'export const alpha = 1;\nexport const beta = alpha + 1;'
    );

    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [
      {
        uri: vscode.Uri.file('c:\\workspace'),
        index: 0,
        name: 'workspace'
      }
    ] as typeof vscode.workspace.workspaceFolders);

    let pickedLabels: string[] | undefined;
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'beta') as typeof vscode.window.showInputBox);
    const pickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly { label: string; }[]) => {
      pickedLabels = items.map((item) => item.label);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);

    try {
      await goToText(
        index,
        { completionStyleResults: false, fuzzySearch: true, useRipgrep: true, useFzf: false },
        {
          toolRunner: async () => {
            const error = new Error('spawn ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
        }
      );
    } finally {
      restoreProperty(pickPatch);
      restoreProperty(inputPatch);
      restoreProperty(workspaceFoldersPatch);
    }

    assert.deepEqual(pickedLabels, ['src/app/main.ts:2']);
  });

  test('can gather text matches from ripgrep even when the local text index is empty', async () => {
    const index = new TextIndex();
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [
      {
        uri: vscode.Uri.file('c:\\workspace'),
        index: 0,
        name: 'workspace'
      }
    ] as typeof vscode.workspace.workspaceFolders);
    const relativePathPatch = patchProperty(vscode.workspace, 'asRelativePath', ((resource: string | vscode.Uri) => {
      return typeof resource === 'string' ? resource : 'src/external.ts';
    }) as typeof vscode.workspace.asRelativePath);

    let pickedLabels: string[] | undefined;
    let infoMessage: string | undefined;
    const inputPatch = patchProperty(vscode.window, 'showInputBox', (async () => 'gamma') as typeof vscode.window.showInputBox);
    const pickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly { label: string; }[]) => {
      pickedLabels = items.map((item) => item.label);
      return undefined;
    }) as unknown) as typeof vscode.window.showQuickPick);
    const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
      infoMessage = message;
      return undefined;
    }) as typeof vscode.window.showInformationMessage);

    try {
      await goToText(
        index,
        { completionStyleResults: false, fuzzySearch: true, useRipgrep: true, useFzf: false },
        {
          toolRunner: async () => ({
            exitCode: 0,
            stdout: `${JSON.stringify({
              type: 'match',
              data: {
                path: { text: 'c:\\workspace\\src\\external.ts' },
                lines: { text: 'export const gamma = alpha + 1;\n' },
                line_number: 4,
                submatches: [{ start: 13, end: 18, match: { text: 'gamma' } }]
              }
            })}\n`,
            stderr: ''
          })
        }
      );
    } finally {
      restoreProperty(infoPatch);
      restoreProperty(pickPatch);
      restoreProperty(inputPatch);
      restoreProperty(relativePathPatch);
      restoreProperty(workspaceFoldersPatch);
    }

    assert.equal(infoMessage, undefined);
    assert.deepEqual(pickedLabels, ['src/external.ts:4']);
  });
});
