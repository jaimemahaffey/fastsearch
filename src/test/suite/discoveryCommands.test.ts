import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { findImplementations } from '../../commands/findImplementations';
import { findUsages } from '../../commands/findUsages';
import { SymbolIndex } from '../../indexes/symbolIndex';
import { TextIndex } from '../../indexes/textIndex';
import { patchProperty, restoreProperty, type RestorableProperty } from './helpers/propertyPatch';

type QuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
};

suite('discoveryCommands', () => {
  test('findUsages falls back to text and symbol indexes when the provider returns no results', async () => {
    const textIndex = new TextIndex();
    const symbolIndex = new SymbolIndex();
    const textUri = vscode.Uri.file('c:\\workspace\\src\\textMatch.ts');
    const symbolUri = vscode.Uri.file('c:\\workspace\\src\\symbolMatch.ts');
    textIndex.upsert('src/textMatch.ts', textUri.toString(), 'const alpha = beta;');
    symbolIndex.replaceForFile('src/symbolMatch.ts', [
      {
        name: 'alphaHelper',
        kind: vscode.SymbolKind.Function,
        containerName: undefined,
        uri: symbolUri.toString(),
        startLine: 4,
        startColumn: 0,
        approximate: false
      }
    ]);

    let awaitedFallback = false;
    let pickedItems: QuickPickItem[] | undefined;
    const patches = createCommandPatches({
      activeEditor: createEditor('alpha', textUri),
      executeCommand: async (command) => {
        if (command === 'vscode.executeReferenceProvider') {
          return [];
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      asRelativePath: (resource) =>
        isUriMatch(resource, textUri) ? 'src/textMatch.ts' : 'src/symbolMatch.ts',
      showQuickPick: async (items) => {
        pickedItems = items.map((item) => ({
          label: item.label,
          description: item.description,
          detail: item.detail
        }));
        return undefined;
      }
    });

    try {
      await findUsages(textIndex, symbolIndex, async () => {
        awaitedFallback = true;
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, true);
    assert.deepEqual(pickedItems, [
      {
        label: 'src/textMatch.ts:1',
        description: 'Approximate local match',
        detail: textUri.toString()
      },
      {
        label: 'src/symbolMatch.ts:5',
        description: 'Approximate local match',
        detail: symbolUri.toString()
      }
    ]);
  });

  test('findUsages prefers provider results over approximate local matches', async () => {
    const textIndex = new TextIndex();
    const symbolIndex = new SymbolIndex();
    const providerUri = vscode.Uri.file('c:\\workspace\\src\\provider.ts');
    textIndex.upsert('src/textMatch.ts', vscode.Uri.file('c:\\workspace\\src\\textMatch.ts').toString(), 'const alpha = beta;');
    symbolIndex.replaceForFile('src/symbolMatch.ts', [
      {
        name: 'alphaHelper',
        kind: vscode.SymbolKind.Function,
        containerName: undefined,
        uri: vscode.Uri.file('c:\\workspace\\src\\symbolMatch.ts').toString(),
        startLine: 4,
        startColumn: 0,
        approximate: false
      }
    ]);

    let awaitedFallback = false;
    let pickedItems: QuickPickItem[] | undefined;
    const patches = createCommandPatches({
      activeEditor: createEditor('alpha', providerUri),
      executeCommand: async (command) => {
        if (command === 'vscode.executeReferenceProvider') {
          return [new vscode.Location(providerUri, new vscode.Range(2, 0, 2, 5))];
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      asRelativePath: () => 'src/provider.ts',
      showQuickPick: async (items) => {
        pickedItems = items.map((item) => ({
          label: item.label,
          description: item.description,
          detail: item.detail
        }));
        return undefined;
      }
    });

    try {
      await findUsages(textIndex, symbolIndex, async () => {
        awaitedFallback = true;
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, false);
    assert.deepEqual(pickedItems, [
      {
        label: 'src/provider.ts:3',
        description: 'Provider-backed match',
        detail: providerUri.toString()
      }
    ]);
  });

  test('findImplementations presents LocationLink provider results without falling back', async () => {
    const symbolIndex = new SymbolIndex();
    const editorUri = vscode.Uri.file('c:\\workspace\\src\\contract.ts');
    const implementationUri = vscode.Uri.file('c:\\workspace\\src\\implementation.ts');

    let awaitedFallback = false;
    let pickedItems: QuickPickItem[] | undefined;
    const patches = createCommandPatches({
      activeEditor: createEditor('alpha', editorUri),
      executeCommand: async (command) => {
        if (command === 'vscode.executeImplementationProvider') {
          return [
            {
              originSelectionRange: new vscode.Range(0, 0, 0, 5),
              targetUri: implementationUri,
              targetRange: new vscode.Range(6, 0, 6, 10),
              targetSelectionRange: new vscode.Range(7, 2, 7, 12)
            }
          ];
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      asRelativePath: () => 'src/implementation.ts',
      showQuickPick: async (items) => {
        pickedItems = items.map((item) => ({
          label: item.label,
          description: item.description,
          detail: item.detail
        }));
        return undefined;
      }
    });

    try {
      await findImplementations(symbolIndex, async () => {
        awaitedFallback = true;
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, false);
    assert.deepEqual(pickedItems, [
      {
        label: 'src/implementation.ts:8',
        description: 'Provider-backed match',
        detail: implementationUri.toString()
      }
    ]);
  });
});

function createEditor(word: string, uri: vscode.Uri): vscode.TextEditor {
  const wordRange = new vscode.Range(0, 0, 0, word.length);
  const document = {
    uri,
    getWordRangeAtPosition: () => wordRange,
    getText: () => word
  } as Pick<vscode.TextDocument, 'uri' | 'getWordRangeAtPosition' | 'getText'> as vscode.TextDocument;

  return {
    document,
    selection: new vscode.Selection(wordRange.start, wordRange.start)
  } as Pick<vscode.TextEditor, 'document' | 'selection'> as vscode.TextEditor;
}

function createCommandPatches({
  activeEditor,
  executeCommand,
  asRelativePath,
  showQuickPick
}: {
  activeEditor: vscode.TextEditor;
  executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
  asRelativePath: (resource: string | vscode.Uri) => string;
  showQuickPick: (items: readonly QuickPickItem[]) => Promise<QuickPickItem | undefined>;
}): Array<RestorableProperty<object, never>> {
  return [
    patchProperty(vscode.window, 'activeTextEditor', activeEditor as typeof vscode.window.activeTextEditor) as RestorableProperty<object, never>,
    patchProperty(vscode.commands, 'executeCommand', executeCommand as typeof vscode.commands.executeCommand) as RestorableProperty<object, never>,
    patchProperty(vscode.workspace, 'asRelativePath', asRelativePath as typeof vscode.workspace.asRelativePath) as RestorableProperty<object, never>,
    patchProperty(vscode.window, 'showQuickPick', (showQuickPick as unknown) as typeof vscode.window.showQuickPick) as RestorableProperty<object, never>
  ];
}

function restorePatches(patches: Array<RestorableProperty<object, never>>): void {
  patches.reverse().forEach((patch) => restoreProperty(patch));
}

function isUriMatch(resource: string | vscode.Uri, uri: vscode.Uri): boolean {
  return typeof resource === 'string' ? resource === uri.toString() : resource.toString() === uri.toString();
}
