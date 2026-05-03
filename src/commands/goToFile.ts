import * as vscode from 'vscode';
import type { FastIndexerConfig } from '../configuration';
import type { ExternalToolRunner } from '../externalTools/commandSearchTools';
import { narrowCommandSearchCandidatesWithFzf } from '../externalTools/commandSearchProviders';
import { FileIndex } from '../indexes/fileIndex';
import { filterCommandSearchCandidates, presentCommandSearch, toFileSearchCandidate } from '../shared/commandSearch';

type FileCommandBehavior = Partial<Pick<FastIndexerConfig, 'completionStyleResults' | 'fuzzySearch' | 'useFzf'>>;

type CommandSearchDependencies = {
  toolRunner?: ExternalToolRunner;
};

const DEFAULT_BEHAVIOR: Required<FileCommandBehavior> = {
  completionStyleResults: false,
  fuzzySearch: true,
  useFzf: false
};

export async function goToFile(
  fileIndex: FileIndex,
  behavior: FileCommandBehavior = DEFAULT_BEHAVIOR,
  dependencies: CommandSearchDependencies = {}
): Promise<void> {
  if (fileIndex.isEmpty()) {
    void vscode.window.showInformationMessage('No indexed files are available yet.');
    return;
  }

  const resolvedBehavior = { ...DEFAULT_BEHAVIOR, ...behavior };
  const candidates = fileIndex.all().map(toFileSearchCandidate);
  await presentCommandSearch({
    placeholder: 'Search indexed files',
    noResultsMessage: (query) => `No indexed files matched "${query}".`,
    completionStyleResults: resolvedBehavior.completionStyleResults,
    fuzzySearch: resolvedBehavior.fuzzySearch,
    loadCandidates: async (query, fuzzySearch) => narrowCommandSearchCandidatesWithFzf(
      query,
      filterCommandSearchCandidates(query, candidates, fuzzySearch),
      { enabled: resolvedBehavior.useFzf },
      dependencies.toolRunner
    ),
    toItem: (candidate) => ({
      label: candidate.label,
      description: candidate.description,
      detail: 'Indexed file'
    }),
    onDidAccept: async (candidate) => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(candidate.uri));
        await vscode.window.showTextDocument(document);
      } catch {
        void vscode.window.showErrorMessage(`Unable to open indexed file: ${candidate.description ?? candidate.label}`);
      }
    }
  });
}
