import * as vscode from 'vscode';
import type { DiscoveryResult } from '../commands/findUsages';
import type { SymbolRecord } from '../indexes/symbolIndex';

export async function getDocumentSymbols(uri: vscode.Uri): Promise<SymbolRecord[]> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );

  return flattenDocumentSymbols(symbols ?? [], uri.toString());
}

export async function getReferences(position: vscode.Position): Promise<DiscoveryResult[]> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return [];
  }

  const locations = await vscode.commands.executeCommand<readonly vscode.Location[]>(
    'vscode.executeReferenceProvider',
    editor.document.uri,
    position
  );

  return (locations ?? []).map(toDiscoveryResult);
}

export async function getImplementations(position: vscode.Position): Promise<DiscoveryResult[]> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return [];
  }

  const locations = await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeImplementationProvider',
    editor.document.uri,
    position
  );

  return (locations ?? []).map(toDiscoveryResult);
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

function toDiscoveryResult(location: vscode.Location | vscode.LocationLink): DiscoveryResult {
  if ('targetUri' in location) {
    const targetRange = location.targetSelectionRange ?? location.targetRange;
    return {
      uri: location.targetUri.toString(),
      line: targetRange.start.line,
      approximate: false
    };
  }

  return {
    uri: location.uri.toString(),
    line: location.range.start.line,
    approximate: false
  };
}
