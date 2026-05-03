import * as vscode from 'vscode';
import { getReferences } from '../bridge/providerBridge';
import { SymbolIndex } from '../indexes/symbolIndex';
import { TextIndex } from '../indexes/textIndex';

export type DiscoveryResult = {
  uri: string;
  line: number;
  approximate: boolean;
};

export type DiscoveryFallbackOptions = {
  allowTextFallback?: boolean;
  allowSymbolFallback?: boolean;
  awaitFallbackReady?: () => Promise<boolean | void>;
};

export function chooseUsageResults(
  providerResults: DiscoveryResult[],
  fallbackResults: DiscoveryResult[]
): DiscoveryResult[] {
  return providerResults.length > 0 ? providerResults : fallbackResults;
}

export async function findUsages(
  textIndex: TextIndex,
  symbolIndex: SymbolIndex,
  options: DiscoveryFallbackOptions = {}
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Open an editor to find usages.');
    return;
  }

  const position = editor.selection.active;
  const wordRange = editor.document.getWordRangeAtPosition(position);
  const query = wordRange ? editor.document.getText(wordRange).trim() : editor.document.getText(editor.selection).trim();
  if (!query) {
    void vscode.window.showInformationMessage('Place the cursor on a symbol to find usages.');
    return;
  }

  let providerResults: DiscoveryResult[] = [];

  try {
    providerResults = await getReferences(position);
  } catch {
    providerResults = [];
  }

  let fallbackResults: DiscoveryResult[] = [];
  const allowTextFallback = options.allowTextFallback ?? true;
  const allowSymbolFallback = options.allowSymbolFallback ?? true;
  if (providerResults.length === 0 && (allowTextFallback || allowSymbolFallback)) {
    const fallbackReady = await options.awaitFallbackReady?.();
    if (fallbackReady === false) {
      return;
    }

    fallbackResults = mergeApproximateResults(
      allowTextFallback ? textIndex.findApproximateUsages(query) : [],
      allowSymbolFallback ? symbolIndex.findApproximateUsages(query) : []
    );
  }

  const results = chooseUsageResults(providerResults, fallbackResults);
  if (results.length === 0) {
    void vscode.window.showInformationMessage(`No usages found for "${query}".`);
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

function mergeApproximateResults(...resultSets: DiscoveryResult[][]): DiscoveryResult[] {
  const merged: DiscoveryResult[] = [];
  const seen = new Set<string>();

  for (const result of resultSets.flat()) {
    const key = `${result.uri}:${result.line}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(result);
  }

  return merged;
}
