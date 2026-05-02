import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getDocumentSymbols } from '../../bridge/providerBridge';
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
});
