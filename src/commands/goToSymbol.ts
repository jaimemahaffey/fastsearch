import * as vscode from 'vscode';
import type { FastIndexerConfig } from '../configuration';
import type { ExternalToolRunner } from '../externalTools/commandSearchTools';
import { narrowCommandSearchCandidatesWithFzf } from '../externalTools/commandSearchProviders';
import { SymbolIndex } from '../indexes/symbolIndex';
import { createSymbolSemanticKey, type SemanticIndex } from '../semantics/semanticIndex';
import { filterCommandSearchCandidates, presentCommandSearch, toSymbolSearchCandidate, withCommandSearchProvenanceIcon } from '../shared/commandSearch';

type SymbolCommandBehavior = Partial<Pick<FastIndexerConfig, 'completionStyleResults' | 'fuzzySearch' | 'useFzf'>>;
type CommandSearchPresentation = {
  title?: string;
  placeholder?: string;
  onDidHide?: () => void;
  debugLog?: (message: string) => void;
  activeContextKey?: string;
  partialResultsMessage?: string;
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
  presentation: CommandSearchPresentation = {},
  semanticIndex?: SemanticIndex
): Promise<boolean> {
  if (symbolIndex.isEmpty()) {
    void vscode.window.showInformationMessage('No indexed symbols are available yet.');
    return false;
  }

  const resolvedBehavior = { ...DEFAULT_BEHAVIOR, ...behavior };
  const candidates = symbolIndex.all().map((symbol) => {
    const relativePath = vscode.workspace.asRelativePath(vscode.Uri.parse(symbol.uri), true);
    const semanticMetadata = semanticIndex?.get(relativePath, createSymbolSemanticKey(symbol));
    return toSymbolSearchCandidate(symbol, semanticMetadata);
  });
  return presentCommandSearch({
    title: presentation.title,
    placeholder: presentation.placeholder ?? 'Search indexed symbols',
    noResultsMessage: (query) => `No indexed symbols matched "${query}".`,
    completionStyleResults: resolvedBehavior.completionStyleResults,
    fuzzySearch: resolvedBehavior.fuzzySearch,
    debugLog: presentation.debugLog,
    activeContextKey: presentation.activeContextKey,
    loadCandidates: async (query, fuzzySearch) => narrowCommandSearchCandidatesWithFzf(
      query,
      filterCommandSearchCandidates(query, candidates, fuzzySearch),
      { enabled: resolvedBehavior.useFzf },
      dependencies.toolRunner
    ),
    toItem: (candidate) => withCommandSearchProvenanceIcon(candidate, {
      label: candidate.label,
      description: candidate.description,
      detail: withPartialResultsMessage(candidate.detail, presentation.partialResultsMessage)
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

function withPartialResultsMessage(detail: string | undefined, partialResultsMessage: string | undefined): string | undefined {
  if (!partialResultsMessage) {
    return detail;
  }

  return detail ? `${detail} \u00B7 ${partialResultsMessage}` : partialResultsMessage;
}
