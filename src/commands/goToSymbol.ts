import * as vscode from 'vscode';
import type { FastIndexerConfig } from '../configuration';
import type { ExternalToolRunner } from '../externalTools/commandSearchTools';
import { narrowCommandSearchCandidatesWithFzf } from '../externalTools/commandSearchProviders';
import { SymbolIndex } from '../indexes/symbolIndex';
import { filterCommandSearchCandidates, presentCommandSearch, toSymbolSearchCandidate, withCommandSearchProvenanceIcon } from '../shared/commandSearch';

type SymbolCommandBehavior = Partial<Pick<FastIndexerConfig, 'completionStyleResults' | 'fuzzySearch' | 'useFzf'>>;
type CommandSearchPresentation = {
  title?: string;
  placeholder?: string;
  onDidHide?: () => void;
};

type CommandSearchDependencies = {
  toolRunner?: ExternalToolRunner;
};

const DEFAULT_BEHAVIOR: Required<SymbolCommandBehavior> = {
  completionStyleResults: false,
  fuzzySearch: true,
  useFzf: false
};

export async function goToSymbol(
  symbolIndex: SymbolIndex,
  behavior: SymbolCommandBehavior = DEFAULT_BEHAVIOR,
  dependencies: CommandSearchDependencies = {},
  presentation: CommandSearchPresentation = {}
): Promise<boolean> {
  if (symbolIndex.isEmpty()) {
    void vscode.window.showInformationMessage('No indexed symbols are available yet.');
    return false;
  }

  const resolvedBehavior = { ...DEFAULT_BEHAVIOR, ...behavior };
  const candidates = symbolIndex.all().map(toSymbolSearchCandidate);
  return presentCommandSearch({
    title: presentation.title,
    placeholder: presentation.placeholder ?? 'Search indexed symbols',
    noResultsMessage: (query) => `No indexed symbols matched "${query}".`,
    completionStyleResults: resolvedBehavior.completionStyleResults,
    fuzzySearch: resolvedBehavior.fuzzySearch,
    loadCandidates: async (query, fuzzySearch) => narrowCommandSearchCandidatesWithFzf(
      query,
      filterCommandSearchCandidates(query, candidates, fuzzySearch),
      { enabled: resolvedBehavior.useFzf },
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
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(candidate.line ?? 0, candidate.column ?? 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      } catch {
        void vscode.window.showErrorMessage(`Unable to open indexed symbol: ${candidate.label}`);
      }
    },
    onDidHide: presentation.onDidHide
  });
}
