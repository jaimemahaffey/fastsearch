import * as vscode from 'vscode';
import type { ExternalToolRunner } from '../externalTools/commandSearchTools';
import { narrowCommandSearchCandidatesWithFzf } from '../externalTools/commandSearchProviders';
import { filterCommandSearchCandidates, presentCommandSearch, toDiscoverySearchCandidate, withCommandSearchProvenanceIcon } from '../shared/commandSearch';
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
  completionStyleResults?: boolean;
  fuzzySearch?: boolean;
  useFzf?: boolean;
  awaitFallbackReady?: () => Promise<boolean | void>;
};

type CommandSearchDependencies = {
  toolRunner?: ExternalToolRunner;
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
  options: DiscoveryFallbackOptions = {},
  dependencies: CommandSearchDependencies = {}
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

  const candidates = results.map((result) => {
    const candidate = toDiscoverySearchCandidate('usage', result);
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
        ...withCommandSearchProvenanceIcon(candidate, {
          label: candidate.label,
          description: candidate.description,
          detail: candidate.detail
        }),
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
    placeholder: `Filter usages for "${query}"`,
    noResultsMessage: (filterQuery) => `No usages matched "${filterQuery}".`,
    completionStyleResults: true,
    fuzzySearch: options.fuzzySearch ?? true,
    loadCandidates: (filterQuery, fuzzySearch) => narrowCommandSearchCandidatesWithFzf(
      filterQuery,
      filterCommandSearchCandidates(filterQuery, candidates, fuzzySearch),
      { enabled: options.useFzf ?? false },
      dependencies.toolRunner
    ),
    toItem: (candidate) => withCommandSearchProvenanceIcon(candidate, {
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
