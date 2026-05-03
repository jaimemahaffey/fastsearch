import * as vscode from 'vscode';
import type { DiscoveryResult } from '../commands/findUsages';
import type { SymbolRecord } from '../indexes/symbolIndex';
import type { TextMatch } from '../indexes/textIndex';
import { scoreCandidate } from './matchScore';
import type { FileRecord } from './types';

export type CommandSearchSource = 'file' | 'text' | 'symbol' | 'usage' | 'implementation';

export type CommandSearchCandidate = {
  source: CommandSearchSource;
  label: string;
  description?: string;
  detail: string;
  filterText: string;
  uri: string;
  line?: number;
  column?: number;
  approximate: boolean;
};

export type CommandSearchProvider<TContext> = {
  name: string;
  isAvailable: () => boolean;
  provide: (context: TContext) => Promise<CommandSearchCandidate[]>;
};

export type CommandSearchPresentationOptions = {
  title?: string;
  placeholder: string;
  noResultsMessage: (query: string) => string;
  completionStyleResults: boolean;
  fuzzySearch: boolean;
  loadCandidates: (
    query: string,
    fuzzySearch: boolean
  ) => CommandSearchCandidate[] | Promise<CommandSearchCandidate[]>;
  toItem: (candidate: CommandSearchCandidate) => vscode.QuickPickItem;
  onDidAccept: (candidate: CommandSearchCandidate) => Promise<void>;
  onDidHide?: () => void;
};

type CommandSearchPickItem = vscode.QuickPickItem & {
  candidate: CommandSearchCandidate;
};

let activeCommandSearchQuickPick: {
  quickPick: vscode.QuickPick<CommandSearchPickItem>;
  suppressHideHandler: boolean;
} | undefined;

export function toFileSearchCandidate(record: FileRecord): CommandSearchCandidate {
  return {
    source: 'file',
    label: record.basename,
    description: record.relativePath,
    detail: record.uri,
    filterText: `${record.basename} ${record.relativePath}`,
    uri: record.uri,
    approximate: false
  };
}

export function toTextSearchCandidate(match: TextMatch): CommandSearchCandidate {
  return {
    source: 'text',
    label: `${match.relativePath}:${match.line}`,
    description: match.preview,
    detail: match.uri,
    filterText: `${match.relativePath} ${match.preview}`,
    uri: match.uri,
    line: match.line - 1,
    column: match.column - 1,
    approximate: false
  };
}

export function toSymbolSearchCandidate(symbol: SymbolRecord): CommandSearchCandidate {
  return {
    source: 'symbol',
    label: symbol.name,
    description: symbol.containerName,
    detail: symbol.uri,
    filterText: [symbol.name, symbol.containerName].filter(Boolean).join(' '),
    uri: symbol.uri,
    line: symbol.startLine,
    column: symbol.startColumn,
    approximate: symbol.approximate
  };
}

export function toDiscoverySearchCandidate(
  source: 'usage' | 'implementation',
  result: DiscoveryResult
): CommandSearchCandidate {
  return {
    source,
    label: `${result.uri}:${result.line + 1}`,
    description: result.approximate ? 'Approximate local match' : 'Provider-backed match',
    detail: result.uri,
    filterText: result.uri,
    uri: result.uri,
    line: result.line,
    approximate: result.approximate
  };
}

export async function collectAvailableProviderResults<TContext>(
  providers: Array<CommandSearchProvider<TContext>>,
  context: TContext
): Promise<CommandSearchCandidate[]> {
  const results: CommandSearchCandidate[] = [];

  for (const provider of providers) {
    if (!provider.isAvailable()) {
      continue;
    }

    results.push(...await provider.provide(context));
  }

  return results;
}

export function rankCommandSearchCandidates(
  query: string,
  candidates: CommandSearchCandidate[]
): CommandSearchCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(query, candidate.filterText)
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.candidate.label.localeCompare(right.candidate.label))
    .map((entry) => entry.candidate);
}

export function filterCommandSearchCandidates(
  query: string,
  candidates: CommandSearchCandidate[],
  fuzzySearch: boolean
): CommandSearchCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...candidates].sort((left, right) => left.label.localeCompare(right.label));
  }

  if (fuzzySearch) {
    return rankCommandSearchCandidates(query, candidates);
  }

  return candidates.filter((candidate) => candidate.filterText.toLowerCase().includes(needle));
}

export function dedupeCommandSearchCandidates(
  candidates: CommandSearchCandidate[]
): CommandSearchCandidate[] {
  const deduped = new Map<string, CommandSearchCandidate>();

  for (const candidate of candidates) {
    const key = [
      candidate.source,
      candidate.uri,
      candidate.line ?? '',
      candidate.column ?? '',
      candidate.label
    ].join('::');

    if (!deduped.has(key)) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()];
}

export async function presentCommandSearch(options: CommandSearchPresentationOptions): Promise<boolean> {
  if (!options.completionStyleResults) {
    const query = await vscode.window.showInputBox({ prompt: options.placeholder });
    if (!query) {
      options.onDidHide?.();
      return false;
    }

    const candidates = await Promise.resolve(options.loadCandidates(query, options.fuzzySearch));
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(options.noResultsMessage(query));
      options.onDidHide?.();
      return false;
    }

    const pick = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        ...options.toItem(candidate),
        candidate
      })),
      {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: options.placeholder
      }
    );

    if (pick) {
      await options.onDidAccept((pick as CommandSearchPickItem).candidate);
    }

    options.onDidHide?.();

    return true;
  }

  if (activeCommandSearchQuickPick) {
    activeCommandSearchQuickPick.suppressHideHandler = true;
    activeCommandSearchQuickPick.quickPick.hide();
  }

  const quickPick = vscode.window.createQuickPick<CommandSearchPickItem>();
  const quickPickState = {
    quickPick,
    suppressHideHandler: false
  };
  activeCommandSearchQuickPick = quickPickState;
  let updateSequence = 0;
  let hidden = false;
  const updateItems = async (query: string) => {
    const currentSequence = ++updateSequence;
    quickPick.busy = true;
    const candidates = await Promise.resolve(options.loadCandidates(query, options.fuzzySearch));
    if (hidden || currentSequence !== updateSequence) {
      return;
    }

    quickPick.items = candidates.map((candidate) => ({
      ...options.toItem(candidate),
      candidate
    }));
    quickPick.placeholder = query && candidates.length === 0
      ? options.noResultsMessage(query)
      : options.placeholder;
    quickPick.busy = false;
  };

  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.title = options.title ?? '';
  quickPick.placeholder = options.placeholder;
  quickPick.onDidChangeValue((query) => {
    void updateItems(query);
  });
  quickPick.onDidAccept(() => {
    const candidate = quickPick.selectedItems[0]?.candidate;
    if (candidate) {
      void options.onDidAccept(candidate);
    }

    quickPick.hide();
  });
  quickPick.onDidHide(() => {
    hidden = true;
    if (activeCommandSearchQuickPick === quickPickState) {
      activeCommandSearchQuickPick = undefined;
    }
    quickPick.dispose();
    if (!quickPickState.suppressHideHandler) {
      options.onDidHide?.();
    }
  });

  quickPick.show();
  await updateItems('');
  return true;
}
