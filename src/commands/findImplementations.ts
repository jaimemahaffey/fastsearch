import * as vscode from 'vscode';
import { getImplementations } from '../bridge/providerBridge';
import { SymbolIndex } from '../indexes/symbolIndex';
import type { DiscoveryFallbackOptions, DiscoveryResult } from './findUsages';

export function chooseImplementationResults(
  providerResults: DiscoveryResult[],
  fallbackResults: DiscoveryResult[]
): DiscoveryResult[] {
  return providerResults.length > 0 ? providerResults : fallbackResults;
}

export async function findImplementations(
  symbolIndex: SymbolIndex,
  options: DiscoveryFallbackOptions = {}
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Open an editor to find implementations.');
    return;
  }

  const position = editor.selection.active;
  const wordRange = editor.document.getWordRangeAtPosition(position);
  const query = wordRange ? editor.document.getText(wordRange).trim() : editor.document.getText(editor.selection).trim();
  if (!query) {
    void vscode.window.showInformationMessage('Place the cursor on a symbol to find implementations.');
    return;
  }

  let providerResults: DiscoveryResult[] = [];

  try {
    providerResults = await getImplementations(position);
  } catch {
    providerResults = [];
  }

  let fallbackResults: DiscoveryResult[] = [];
  if (providerResults.length === 0 && (options.allowSymbolFallback ?? true)) {
    const fallbackReady = await options.awaitFallbackReady?.();
    if (fallbackReady === false) {
      return;
    }

    fallbackResults = symbolIndex.findApproximateImplementations(query);
  }

  const results = chooseImplementationResults(providerResults, fallbackResults);
  if (results.length === 0) {
    void vscode.window.showInformationMessage(`No implementations found for "${query}".`);
    return;
  }

  const pick = await vscode.window.showQuickPick(
    results.map((result) => {
      const uri = vscode.Uri.parse(result.uri);
      return {
        label: `${vscode.workspace.asRelativePath(uri, true)}:${result.line + 1}`,
        description: result.approximate ? 'Approximate local match' : 'Provider-backed match',
        detail: result.uri,
        result
      };
    })
  );

  if (!pick) {
    return;
  }

  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(pick.result.uri));
    const shownEditor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(pick.result.line, 0);
    shownEditor.selection = new vscode.Selection(position, position);
    shownEditor.revealRange(new vscode.Range(position, position));
  } catch {
    void vscode.window.showErrorMessage(`Unable to open indexed discovery result: ${pick.label}`);
  }
}
