import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  getDeclarations,
  getDefinitions,
  getDocumentSymbols,
  getHoverSummary,
  getImplementationsAt,
  getReferencesAt,
  getTypeDefinitions
} from '../../bridge/providerBridge';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('providerBridge', () => {
  test('flattens nested document symbols and derives container names from parents', async () => {
    const uri = vscode.Uri.file('c:\\workspace\\src\\userService.ts');
    const range = new vscode.Range(0, 0, 20, 0);
    const classSymbol = new vscode.DocumentSymbol('UserService', 'class detail', vscode.SymbolKind.Class, range, new vscode.Range(1, 0, 1, 11));
    const methodSymbol = new vscode.DocumentSymbol('createUser', 'method detail', vscode.SymbolKind.Method, range, new vscode.Range(4, 2, 4, 12));
    const propertySymbol = new vscode.DocumentSymbol('repository', 'property detail', vscode.SymbolKind.Property, range, new vscode.Range(6, 2, 6, 12));
    const nestedSymbol = new vscode.DocumentSymbol('validator', 'nested detail', vscode.SymbolKind.Variable, range, new vscode.Range(8, 4, 8, 13));
    propertySymbol.children.push(nestedSymbol);
    classSymbol.children.push(methodSymbol, propertySymbol);

    const commandPatch = patchProperty(vscode.commands, 'executeCommand', (async () => [classSymbol]) as typeof vscode.commands.executeCommand);

    try {
      const records = await getDocumentSymbols(uri);

      assert.deepEqual(records, [
        {
          name: 'UserService',
          kind: vscode.SymbolKind.Class,
          containerName: undefined,
          uri: uri.toString(),
          startLine: 1,
          startColumn: 0,
          approximate: false
        },
        {
          name: 'createUser',
          kind: vscode.SymbolKind.Method,
          containerName: 'UserService',
          uri: uri.toString(),
          startLine: 4,
          startColumn: 2,
          approximate: false
        },
        {
          name: 'repository',
          kind: vscode.SymbolKind.Property,
          containerName: 'UserService',
          uri: uri.toString(),
          startLine: 6,
          startColumn: 2,
          approximate: false
        },
        {
          name: 'validator',
          kind: vscode.SymbolKind.Variable,
          containerName: 'repository',
          uri: uri.toString(),
          startLine: 8,
          startColumn: 4,
          approximate: false
        }
      ]);
    } finally {
      restoreProperty(commandPatch);
    }
  });

  suite('semantic providers', () => {
    test('converts definition, declaration, and type-definition locations into semantic targets', async () => {
      const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
      const targetUri = vscode.Uri.file('c:\\workspace\\src\\target.ts');
      const position = new vscode.Position(3, 4);
      const calls: string[] = [];
      const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
        calls.push(command);

        if (command === 'vscode.executeDefinitionProvider') {
          return [new vscode.Location(targetUri, new vscode.Range(10, 2, 10, 12))];
        }

        if (command === 'vscode.executeDeclarationProvider') {
          return [{
            targetUri,
            targetRange: new vscode.Range(20, 0, 20, 8),
            targetSelectionRange: new vscode.Range(21, 3, 21, 9)
          }];
        }

        if (command === 'vscode.executeTypeDefinitionProvider') {
          return [new vscode.Location(targetUri, new vscode.Range(30, 5, 30, 15))];
        }

        throw new Error(`Unexpected command ${command}`);
      }) as typeof vscode.commands.executeCommand);

      try {
        assert.deepEqual(await getDefinitions(sourceUri, position), {
          ok: true,
          value: [{ uri: targetUri.toString(), line: 10, column: 2 }]
        });
        assert.deepEqual(await getDeclarations(sourceUri, position), {
          ok: true,
          value: [{ uri: targetUri.toString(), line: 21, column: 3 }]
        });
        assert.deepEqual(await getTypeDefinitions(sourceUri, position), {
          ok: true,
          value: [{ uri: targetUri.toString(), line: 30, column: 5 }]
        });
        assert.deepEqual(calls, [
          'vscode.executeDefinitionProvider',
          'vscode.executeDeclarationProvider',
          'vscode.executeTypeDefinitionProvider'
        ]);
      } finally {
        restoreProperty(executePatch);
      }
    });

    test('returns explicit failures when semantic providers throw', async () => {
      const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
      const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => {
        throw new Error('provider exploded');
      }) as typeof vscode.commands.executeCommand);

      try {
        assert.deepEqual(await getDefinitions(sourceUri, new vscode.Position(0, 0)), {
          ok: false,
          error: 'provider exploded'
        });
        assert.deepEqual(await getDeclarations(sourceUri, new vscode.Position(0, 0)), {
          ok: false,
          error: 'provider exploded'
        });
        assert.deepEqual(await getTypeDefinitions(sourceUri, new vscode.Position(0, 0)), {
          ok: false,
          error: 'provider exploded'
        });
      } finally {
        restoreProperty(executePatch);
      }
    });

    test('summarizes hover markdown and plain string content', async () => {
      const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
      const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
        assert.equal(command, 'vscode.executeHoverProvider');
        return [{
          contents: [
            new vscode.MarkdownString('```ts\\nclass Alpha\\n```'),
            'Creates alpha values.'
          ]
        }];
      }) as typeof vscode.commands.executeCommand);

      try {
        assert.deepEqual(await getHoverSummary(sourceUri, new vscode.Position(0, 0)), {
          ok: true,
          value: 'class Alpha Creates alpha values.'
        });
      } finally {
        restoreProperty(executePatch);
      }
    });

    test('handles deprecated MarkedString object format in hover content', async () => {
      const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
      const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
        assert.equal(command, 'vscode.executeHoverProvider');
        return [{
          contents: [
            { language: 'typescript', value: 'interface User' }
          ]
        }];
      }) as typeof vscode.commands.executeCommand);

      try {
        assert.deepEqual(await getHoverSummary(sourceUri, new vscode.Position(0, 0)), {
          ok: true,
          value: 'typescript interface User'
        });
      } finally {
        restoreProperty(executePatch);
      }
    });

    test('returns undefined when hover content is empty', async () => {
      const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
      const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
        assert.equal(command, 'vscode.executeHoverProvider');
        return [{
          contents: []
        }];
      }) as typeof vscode.commands.executeCommand);

      try {
        assert.deepEqual(await getHoverSummary(sourceUri, new vscode.Position(0, 0)), {
          ok: true,
          value: undefined
        });
      } finally {
        restoreProperty(executePatch);
      }
    });

    test('returns explicit failures when hover provider throws', async () => {
      const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
      const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => {
        throw new Error('hover provider exploded');
      }) as typeof vscode.commands.executeCommand);

      try {
        assert.deepEqual(await getHoverSummary(sourceUri, new vscode.Position(0, 0)), {
          ok: false,
          error: 'hover provider exploded'
        });
      } finally {
        restoreProperty(executePatch);
      }
    });

    test('uses explicit document URIs for background reference and implementation calls', async () => {
      const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
      const targetUri = vscode.Uri.file('c:\\workspace\\src\\target.ts');
      const position = new vscode.Position(2, 3);
      const calls: Array<{ command: string; uri: string; }> = [];
      const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri: vscode.Uri) => {
        calls.push({ command, uri: uri.toString() });

        if (command === 'vscode.executeReferenceProvider') {
          return [new vscode.Location(targetUri, new vscode.Range(4, 1, 4, 6))];
        }

        if (command === 'vscode.executeImplementationProvider') {
          return [new vscode.Location(targetUri, new vscode.Range(8, 2, 8, 7))];
        }

        throw new Error(`Unexpected command ${command}`);
      }) as typeof vscode.commands.executeCommand);

      try {
        assert.deepEqual(await getReferencesAt(sourceUri, position), [{
          uri: targetUri.toString(),
          line: 4,
          approximate: false
        }]);
        assert.deepEqual(await getImplementationsAt(sourceUri, position), [{
          uri: targetUri.toString(),
          line: 8,
          approximate: false
        }]);
        assert.deepEqual(calls, [
          { command: 'vscode.executeReferenceProvider', uri: sourceUri.toString() },
          { command: 'vscode.executeImplementationProvider', uri: sourceUri.toString() }
        ]);
      } finally {
        restoreProperty(executePatch);
      }
    });
  });
});
