import * as vscode from 'vscode';
import type { SymbolRecord } from '../indexes/symbolIndex';

export async function getDocumentSymbols(uri: vscode.Uri): Promise<SymbolRecord[]> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );

  return (symbols ?? []).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    containerName: symbol.detail,
    uri: uri.toString(),
    startLine: symbol.selectionRange.start.line,
    startColumn: symbol.selectionRange.start.character,
    approximate: false
  }));
}
