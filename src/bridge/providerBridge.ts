import * as vscode from 'vscode';
import type { SymbolRecord } from '../indexes/symbolIndex';

export async function getDocumentSymbols(uri: vscode.Uri): Promise<SymbolRecord[]> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );

  return flattenDocumentSymbols(symbols ?? [], uri.toString());
}

function flattenDocumentSymbols(
  symbols: readonly vscode.DocumentSymbol[],
  uri: string,
  parentName?: string
): SymbolRecord[] {
  return symbols.flatMap((symbol) => [
    {
      name: symbol.name,
      kind: symbol.kind,
      containerName: parentName,
      uri,
      startLine: symbol.selectionRange.start.line,
      startColumn: symbol.selectionRange.start.character,
      approximate: false
    },
    ...flattenDocumentSymbols(symbol.children, uri, symbol.name)
  ]);
}
