import * as vscode from 'vscode';
import type { DiscoveryResult } from '../commands/findUsages';
import type { SymbolRecord } from '../indexes/symbolIndex';
import type { SemanticTarget } from '../semantics/semanticTypes';

export type ProviderCallResult<T> =
  | { ok: true; value: T; }
  | { ok: false; error: string; };

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

export async function getDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<SemanticTarget[]>> {
  return getLocationTargets('vscode.executeDefinitionProvider', uri, position);
}

export async function getDeclarations(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<SemanticTarget[]>> {
  return getLocationTargets('vscode.executeDeclarationProvider', uri, position);
}

export async function getTypeDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<SemanticTarget[]>> {
  return getLocationTargets('vscode.executeTypeDefinitionProvider', uri, position);
}

export async function getHoverSummary(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<string | undefined>> {
  try {
    const hovers = await vscode.commands.executeCommand<readonly vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      position
    );
    const summary = (hovers ?? [])
      .flatMap((hover) => hover.contents)
      .map(markedStringToText)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return { ok: true, value: summary.length > 0 ? summary : undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getReferencesAt(uri: vscode.Uri, position: vscode.Position): Promise<DiscoveryResult[]> {
  const locations = await vscode.commands.executeCommand<readonly vscode.Location[]>(
    'vscode.executeReferenceProvider',
    uri,
    position
  );

  return (locations ?? []).map(toDiscoveryResult);
}

export async function getImplementationsAt(uri: vscode.Uri, position: vscode.Position): Promise<DiscoveryResult[]> {
  const locations = await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeImplementationProvider',
    uri,
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

async function getLocationTargets(
  command: 'vscode.executeDefinitionProvider' | 'vscode.executeDeclarationProvider' | 'vscode.executeTypeDefinitionProvider',
  uri: vscode.Uri,
  position: vscode.Position
): Promise<ProviderCallResult<SemanticTarget[]>> {
  try {
    const locations = await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
      command,
      uri,
      position
    );

    return { ok: true, value: (locations ?? []).map(toSemanticTarget) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function toSemanticTarget(location: vscode.Location | vscode.LocationLink): SemanticTarget {
  if ('targetUri' in location) {
    const targetRange = location.targetSelectionRange ?? location.targetRange;
    return {
      uri: location.targetUri.toString(),
      line: targetRange.start.line,
      column: targetRange.start.character
    };
  }

  return {
    uri: location.uri.toString(),
    line: location.range.start.line,
    column: location.range.start.character
  };
}

function markedStringToText(value: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof value === 'string') {
    return value.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '').trim();
  }

  if (value instanceof vscode.MarkdownString) {
    // Handle both real newlines and escaped \n in markdown
    return value.value
      .replace(/```[a-zA-Z0-9_-]*\\n?/g, '')  // Remove code fences with escaped \n
      .replace(/```[a-zA-Z0-9_-]*\n?/g, '')   // Remove code fences with real \n
      .replace(/```/g, '')                     // Remove any remaining backticks
      .replace(/\\n/g, ' ')                    // Replace escaped \n with space
      .replace(/\n/g, ' ')                     // Replace real newlines with space
      .trim();
  }

  return `${value.language} ${value.value}`.trim();
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
