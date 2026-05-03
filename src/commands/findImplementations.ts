import * as vscode from 'vscode';
import { getImplementations } from '../bridge/providerBridge';
import type { ExternalToolRunner } from '../externalTools/commandSearchTools';
import { narrowCommandSearchCandidatesWithFzf } from '../externalTools/commandSearchProviders';
import { filterCommandSearchCandidates, presentCommandSearch, toDiscoverySearchCandidate } from '../shared/commandSearch';
import { SymbolIndex } from '../indexes/symbolIndex';
import type { DiscoveryFallbackOptions, DiscoveryResult } from './findUsages';

type CommandSearchDependencies = {
  toolRunner?: ExternalToolRunner;
};

export function chooseImplementationResults(
  providerResults: DiscoveryResult[],
  fallbackResults: DiscoveryResult[]
): DiscoveryResult[] {
  return providerResults.length > 0 ? providerResults : fallbackResults;
}

export async function findImplementations(
  symbolIndex: SymbolIndex,
  options: DiscoveryFallbackOptions = {},
  dependencies: CommandSearchDependencies = {}
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

  const candidates = results.map((result) => {
    const candidate = toDiscoverySearchCandidate('implementation', result);
    const relativePath = vscode.workspace.asRelativePath(vscode.Uri.parse(result.uri), true);
    return {
      ...candidate,
      label: `${relativePath}:${result.line + 1}`,
      detail: relativePath
    };
  });

  if (!(options.completionStyleResults ?? false)) {
    const pick = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: candidate.label,
        description: candidate.description,
        detail: candidate.detail,
        candidate
      }))
    );

    if (!pick) {
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(pick.candidate.uri));
      const shownEditor = await vscode.window.showTextDocument(document);
      const position = new vscode.Position(pick.candidate.line ?? 0, 0);
      shownEditor.selection = new vscode.Selection(position, position);
      shownEditor.revealRange(new vscode.Range(position, position));
    } catch {
      void vscode.window.showErrorMessage(`Unable to open indexed discovery result: ${pick.label}`);
    }

    return;
  }

  await presentCommandSearch({
    placeholder: `Filter implementations for "${query}"`,
    noResultsMessage: (filterQuery) => `No implementations matched "${filterQuery}".`,
    completionStyleResults: true,
    fuzzySearch: options.fuzzySearch ?? true,
    loadCandidates: (filterQuery, fuzzySearch) => narrowCommandSearchCandidatesWithFzf(
      filterQuery,
      filterCommandSearchCandidates(filterQuery, candidates, fuzzySearch),
      { enabled: options.useFzf ?? false },
      dependencies.toolRunner
    ),
    toItem: (candidate) => ({
      label: candidate.label,
      description: candidate.description,
      detail: candidate.detail
    }),
    onDidAccept: async (candidate) => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(candidate.uri));
        const shownEditor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(candidate.line ?? 0, 0);
        shownEditor.selection = new vscode.Selection(position, position);
        shownEditor.revealRange(new vscode.Range(position, position));
      } catch {
        void vscode.window.showErrorMessage(`Unable to open indexed discovery result: ${candidate.label}`);
      }
    }
  });
}
