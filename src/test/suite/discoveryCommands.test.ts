import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { findImplementations } from '../../commands/findImplementations';
import { findUsages } from '../../commands/findUsages';
import { SymbolIndex } from '../../indexes/symbolIndex';
import { TextIndex } from '../../indexes/textIndex';
import { FakeQuickPick } from './helpers/fakeQuickPick';
import { patchProperty, restoreProperty, type RestorableProperty } from './helpers/propertyPatch';

type QuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  iconPath?: vscode.ThemeIcon;
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
          detail: item.detail,
          iconPath: item.iconPath as vscode.ThemeIcon | undefined
        }));
        return undefined;
      }
    });

    try {
      await findUsages(textIndex, symbolIndex, {
        awaitFallbackReady: async () => {
          awaitedFallback = true;
        }
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, true);
    assert.deepEqual(pickedItems, [
        {
          label: 'src/textMatch.ts:1',
          description: undefined,
          detail: 'src/textMatch.ts',
          iconPath: new vscode.ThemeIcon('circle-small', new vscode.ThemeColor('problemsWarningIcon.foreground'))
        },
        {
          label: 'src/symbolMatch.ts:5',
          description: undefined,
          detail: 'src/symbolMatch.ts',
          iconPath: new vscode.ThemeIcon('circle-small', new vscode.ThemeColor('problemsWarningIcon.foreground'))
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
          detail: item.detail,
          iconPath: item.iconPath as vscode.ThemeIcon | undefined
        }));
        return undefined;
      }
    });

    try {
      await findUsages(textIndex, symbolIndex, {
        awaitFallbackReady: async () => {
          awaitedFallback = true;
        }
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, false);
    assert.deepEqual(pickedItems, [
      {
        label: 'src/provider.ts:3',
        description: undefined,
        detail: 'src/provider.ts',
        iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
      }
    ]);
  });

  test('findImplementations keeps provider results ahead of enriched fallback symbols', async () => {
    const symbolIndex = new SymbolIndex();
    const contractUri = vscode.Uri.file('c:\\workspace\\src\\contract.ts');
    const providerUri = vscode.Uri.file('c:\\workspace\\src\\provider-impl.ts');
    const fallbackUri = vscode.Uri.file('c:\\workspace\\src\\fallback-impl.ts');
    symbolIndex.replaceForFile('src/fallback-impl.ts', [{
      name: 'alphaImplementation',
      kind: vscode.SymbolKind.Class,
      uri: fallbackUri.toString(),
      startLine: 10,
      startColumn: 0,
      approximate: false
    }]);

    let awaitedFallback = false;
    let pickedItems: QuickPickItem[] | undefined;
    const patches = createCommandPatches({
      activeEditor: createEditor('alpha', contractUri),
      executeCommand: async (command) => {
        if (command === 'vscode.executeImplementationProvider') {
          return [new vscode.Location(providerUri, new vscode.Range(4, 0, 4, 5))];
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      asRelativePath: (resource) =>
        isUriMatch(resource, providerUri) ? 'src/provider-impl.ts' : 'src/fallback-impl.ts',
      showQuickPick: async (items) => {
        pickedItems = items.map((item) => ({
          label: item.label,
          description: item.description,
          detail: item.detail,
          iconPath: item.iconPath as vscode.ThemeIcon | undefined
        }));
        return undefined;
      }
    });

    try {
      await findImplementations(symbolIndex, {
        awaitFallbackReady: async () => {
          awaitedFallback = true;
        }
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, false);
    assert.deepEqual(pickedItems?.map((item) => item.label), ['src/provider-impl.ts:5']);
    assert.equal((pickedItems?.[0]?.iconPath as vscode.ThemeIcon | undefined)?.id, 'circle-filled');
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
          detail: item.detail,
          iconPath: item.iconPath as vscode.ThemeIcon | undefined
        }));
        return undefined;
      }
    });

    try {
      await findImplementations(symbolIndex, {
        awaitFallbackReady: async () => {
          awaitedFallback = true;
        }
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, false);
    assert.deepEqual(pickedItems, [
      {
        label: 'src/implementation.ts:8',
        description: undefined,
        detail: 'src/implementation.ts',
        iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
      }
    ]);
  });

  test('findUsages keeps provider-first results while allowing completion-style narrowing', async () => {
    const textIndex = new TextIndex();
    const symbolIndex = new SymbolIndex();
    const providerAlphaUri = vscode.Uri.file('c:\\workspace\\src\\provider-alpha.ts');
    const providerBetaUri = vscode.Uri.file('c:\\workspace\\src\\provider-beta.ts');
    const quickPick = new FakeQuickPick<vscode.QuickPickItem & { description?: string; detail?: string; }>();
    let awaitedFallback = false;

    const patches = createCommandPatches({
      activeEditor: createEditor('alpha', providerAlphaUri),
      executeCommand: async (command) => {
        if (command === 'vscode.executeReferenceProvider') {
          return [
            new vscode.Location(providerAlphaUri, new vscode.Range(2, 0, 2, 5)),
            new vscode.Location(providerBetaUri, new vscode.Range(5, 0, 5, 5))
          ];
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      asRelativePath: (resource) =>
        isUriMatch(resource, providerAlphaUri) ? 'src/provider-alpha.ts' : 'src/provider-beta.ts',
      showQuickPick: async () => undefined,
      createQuickPick: ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick
    });

    try {
      await findUsages(textIndex, symbolIndex, {
        completionStyleResults: true,
        fuzzySearch: true,
        awaitFallbackReady: async () => {
          awaitedFallback = true;
        }
      });

      assert.equal(quickPick.showed, true);
      assert.deepEqual(quickPick.items.map((item) => item.label), [
        'src/provider-alpha.ts:3',
        'src/provider-beta.ts:6'
      ]);

      const narrowedItems = quickPick.waitForItemsUpdate();
      quickPick.fireChangeValue('beta');
      await narrowedItems;

      assert.deepEqual(quickPick.items.map((item) => item.label), ['src/provider-beta.ts:6']);
      assert.equal(quickPick.items[0]?.description, undefined);
      assert.equal(quickPick.items[0]?.detail, 'src/provider-beta.ts');
      assert.equal((quickPick.items[0]?.iconPath as vscode.ThemeIcon | undefined)?.id, 'circle-filled');
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, false);
  });

  test('findImplementations allows completion-style narrowing over fallback results', async () => {
    const symbolIndex = new SymbolIndex();
    const contractUri = vscode.Uri.file('c:\\workspace\\src\\contract.ts');
    const implementationOneUri = vscode.Uri.file('c:\\workspace\\src\\impl-one.ts');
    const implementationTwoUri = vscode.Uri.file('c:\\workspace\\src\\impl-two.ts');
    symbolIndex.replaceForFile('src/impl-one.ts', [
      {
        name: 'alphaImplOne',
        kind: vscode.SymbolKind.Class,
        containerName: undefined,
        uri: implementationOneUri.toString(),
        startLine: 3,
        startColumn: 0,
        approximate: false
      }
    ]);
    symbolIndex.replaceForFile('src/impl-two.ts', [
      {
        name: 'alphaImplTwo',
        kind: vscode.SymbolKind.Class,
        containerName: undefined,
        uri: implementationTwoUri.toString(),
        startLine: 8,
        startColumn: 0,
        approximate: false
      }
    ]);

    const quickPick = new FakeQuickPick<vscode.QuickPickItem & { description?: string; detail?: string; }>();
    let awaitedFallback = false;
    const patches = createCommandPatches({
      activeEditor: createEditor('alpha', contractUri),
      executeCommand: async (command) => {
        if (command === 'vscode.executeImplementationProvider') {
          return [];
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      asRelativePath: (resource) => {
        if (isUriMatch(resource, implementationOneUri)) {
          return 'src/impl-one.ts';
        }

        return 'src/impl-two.ts';
      },
      showQuickPick: async () => undefined,
      createQuickPick: ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick
    });

    try {
      await findImplementations(symbolIndex, {
        completionStyleResults: true,
        fuzzySearch: true,
        awaitFallbackReady: async () => {
          awaitedFallback = true;
        }
      });

      assert.equal(quickPick.showed, true);
      assert.deepEqual(quickPick.items.map((item) => item.label), [
        'src/impl-one.ts:4',
        'src/impl-two.ts:9'
      ]);

      const narrowedItems = quickPick.waitForItemsUpdate();
      quickPick.fireChangeValue('two');
      await narrowedItems;

      assert.deepEqual(quickPick.items.map((item) => item.label), ['src/impl-two.ts:9']);
      assert.equal(quickPick.items[0]?.description, undefined);
      assert.equal(quickPick.items[0]?.detail, 'src/impl-two.ts');
      assert.equal((quickPick.items[0]?.iconPath as vscode.ThemeIcon | undefined)?.id, 'circle-small');
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, true);
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
  showQuickPick,
  createQuickPick
}: {
  activeEditor: vscode.TextEditor;
  executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
  asRelativePath: (resource: string | vscode.Uri) => string;
  showQuickPick: (items: readonly QuickPickItem[]) => Promise<QuickPickItem | undefined>;
  createQuickPick?: typeof vscode.window.createQuickPick;
}): Array<RestorableProperty<object, never>> {
  const patches = [
    patchProperty(vscode.window, 'activeTextEditor', activeEditor as typeof vscode.window.activeTextEditor) as RestorableProperty<object, never>,
    patchProperty(vscode.commands, 'executeCommand', executeCommand as typeof vscode.commands.executeCommand) as RestorableProperty<object, never>,
    patchProperty(vscode.workspace, 'asRelativePath', asRelativePath as typeof vscode.workspace.asRelativePath) as RestorableProperty<object, never>,
    patchProperty(vscode.window, 'showQuickPick', (showQuickPick as unknown) as typeof vscode.window.showQuickPick) as RestorableProperty<object, never>
  ];

  if (createQuickPick) {
    patches.push(
      patchProperty(vscode.window, 'createQuickPick', createQuickPick) as RestorableProperty<object, never>
    );
  }

  return patches;
}

function restorePatches(patches: Array<RestorableProperty<object, never>>): void {
  patches.reverse().forEach((patch) => restoreProperty(patch));
}

function isUriMatch(resource: string | vscode.Uri, uri: vscode.Uri): boolean {
  return typeof resource === 'string' ? resource === uri.toString() : resource.toString() === uri.toString();
}
