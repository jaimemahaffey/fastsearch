import * as vscode from 'vscode';
import type { FastIndexerConfig } from '../configuration';
import type { ExternalToolRunner } from '../externalTools/commandSearchTools';
import { narrowCommandSearchCandidatesWithFzf, searchTextWithRipgrep } from '../externalTools/commandSearchProviders';
import { TextIndex } from '../indexes/textIndex';
import { dedupeCommandSearchCandidates, filterCommandSearchCandidates, presentCommandSearch, toTextSearchCandidate, withCommandSearchProvenanceIcon } from '../shared/commandSearch';

type TextCommandBehavior = Partial<Pick<FastIndexerConfig, 'completionStyleResults' | 'fuzzySearch' | 'useRipgrep' | 'useFzf'>>;
type CommandSearchPresentation = {
  title?: string;
  placeholder?: string;
  onDidHide?: () => void;
  debugLog?: (message: string) => void;
  activeContextKey?: string;
};

type CommandSearchDependencies = {
  toolRunner?: ExternalToolRunner;
};

const DEFAULT_BEHAVIOR: Required<TextCommandBehavior> = {
  completionStyleResults: false,
  fuzzySearch: true,
  useRipgrep: false,
  useFzf: false
};

export async function goToText(
  textIndex: TextIndex,
  behavior: TextCommandBehavior = DEFAULT_BEHAVIOR,
  dependencies: CommandSearchDependencies = {},
  presentation: CommandSearchPresentation = {}
): Promise<boolean> {
  const resolvedBehavior = { ...DEFAULT_BEHAVIOR, ...behavior };
  const canUseRipgrep = resolvedBehavior.useRipgrep && (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (textIndex.isEmpty() && !canUseRipgrep) {
    void vscode.window.showInformationMessage('No indexed text is available yet.');
    return false;
  }

  return presentCommandSearch({
    title: presentation.title,
    placeholder: presentation.placeholder ?? 'Search indexed text',
    noResultsMessage: (query) => `No indexed text matched "${query}".`,
    completionStyleResults: resolvedBehavior.completionStyleResults,
    fuzzySearch: resolvedBehavior.fuzzySearch,
    debugLog: presentation.debugLog,
    activeContextKey: presentation.activeContextKey,
    loadCandidates: async (query, fuzzySearch) => {
      const builtInCandidates = textIndex.searchForCommand(query, fuzzySearch).map(toTextSearchCandidate);
      const ripgrepCandidates = (await searchTextWithRipgrep(
        query,
        { enabled: resolvedBehavior.useRipgrep },
        dependencies.toolRunner
      )).map(toTextSearchCandidate);
      const mergedCandidates = filterCommandSearchCandidates(
        query,
        dedupeCommandSearchCandidates([...ripgrepCandidates, ...builtInCandidates]),
        fuzzySearch
      );

      return narrowCommandSearchCandidatesWithFzf(
        query,
        mergedCandidates,
        { enabled: resolvedBehavior.useFzf },
        dependencies.toolRunner
      );
    },
    toItem: (candidate) => withCommandSearchProvenanceIcon(candidate, {
      label: candidate.label,
      description: candidate.description,
      detail: `Line ${(candidate.line ?? 0) + 1}, Column ${(candidate.column ?? 0) + 1}`
    }),
    onDidAccept: async (candidate) => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(candidate.uri));
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(candidate.line ?? 0, candidate.column ?? 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      } catch {
        void vscode.window.showErrorMessage(`Unable to open indexed file: ${candidate.label.split(':')[0]}`);
      }
    },
    onDidHide: presentation.onDidHide
  });
}
