import * as vscode from 'vscode';
import type { DiscoveryResult } from '../commands/findUsages';
import type { SymbolRecord } from '../indexes/symbolIndex';
import type { TextMatch } from '../indexes/textIndex';
import type { SemanticMetadata } from '../semantics/semanticTypes';
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
  semanticConfidence?: number;
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
  debugLog?: (message: string) => void;
  activeContextKey?: string;
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

export function getCommandSearchDisplayPath(uri: string): string {
  const parsed = vscode.Uri.parse(uri);
  return parsed.scheme === 'file' ? parsed.fsPath : uri;
}

export function toFileSearchCandidate(record: FileRecord): CommandSearchCandidate {
  return {
    source: 'file',
    label: record.basename,
    description: record.relativePath,
    detail: getCommandSearchDisplayPath(record.uri),
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
    detail: getCommandSearchDisplayPath(match.uri),
    filterText: `${match.relativePath} ${match.preview}`,
    uri: match.uri,
    line: match.line - 1,
    column: match.column - 1,
    approximate: false
  };
}

export function getSemanticSymbolDetail(rawUri: string, semanticMetadata?: SemanticMetadata): string {
  const displayPath = getCommandSearchDisplayPath(rawUri);
  if (!semanticMetadata || semanticMetadata.status !== 'enriched') {
    return displayPath;
  }

  const parts: string[] = [displayPath];

  if (semanticMetadata.referenceCount !== undefined) {
    parts.push(`${semanticMetadata.referenceCount} refs`);
  }

  if (semanticMetadata.implementationCount !== undefined) {
    parts.push(`${semanticMetadata.implementationCount} impls`);
  }

  parts.push(semanticMetadata.provider);

  return parts.join(' • ');
}

export function toSymbolSearchCandidate(symbol: SymbolRecord, semanticMetadata?: SemanticMetadata): CommandSearchCandidate {
  const detail = getSemanticSymbolDetail(symbol.uri, semanticMetadata);
  const candidate: CommandSearchCandidate = {
    source: 'symbol',
    label: symbol.name,
    description: symbol.containerName,
    detail,
    filterText: [symbol.name, symbol.containerName].filter(Boolean).join(' '),
    uri: symbol.uri,
    line: symbol.startLine,
    column: symbol.startColumn,
    approximate: symbol.approximate
  };

  if (semanticMetadata) {
    candidate.semanticConfidence = semanticMetadata.confidence;
  }

  return candidate;
}

export function toDiscoverySearchCandidate(
  source: 'usage' | 'implementation',
  result: DiscoveryResult
): CommandSearchCandidate {
  const displayPath = getCommandSearchDisplayPath(result.uri);
  return {
    source,
    label: `${result.uri}:${result.line + 1}`,
    description: undefined,
    detail: displayPath,
    filterText: result.uri,
    uri: result.uri,
    line: result.line,
    approximate: result.approximate
  };
}

export function getCommandSearchProvenanceIcon(candidate: Pick<CommandSearchCandidate, 'approximate'>): vscode.ThemeIcon {
  return candidate.approximate
    ? new vscode.ThemeIcon('circle-small', new vscode.ThemeColor('problemsWarningIcon.foreground'))
    : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
}

export function getCommandSearchIcon(candidate: Pick<CommandSearchCandidate, 'source' | 'approximate'>): vscode.ThemeIcon {
  if (candidate.source === 'file') {
    return new vscode.ThemeIcon('file');
  }

  if (candidate.source === 'text') {
    return new vscode.ThemeIcon('search');
  }

  return getCommandSearchProvenanceIcon(candidate);
}

export function withCommandSearchProvenanceIcon<T extends vscode.QuickPickItem>(
  candidate: Pick<CommandSearchCandidate, 'source' | 'approximate'>,
  item: T
): T & { iconPath: vscode.ThemeIcon } {
  return {
    ...item,
    iconPath: getCommandSearchIcon(candidate)
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
    .sort((left, right) => {
      // First by score
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      // Then by semantic confidence (higher is better)
      const leftConfidence = left.candidate.semanticConfidence ?? 0;
      const rightConfidence = right.candidate.semanticConfidence ?? 0;
      if (rightConfidence !== leftConfidence) {
        return rightConfidence - leftConfidence;
      }
      // Finally by label
      return left.candidate.label.localeCompare(right.candidate.label);
    })
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
    options.debugLog?.(`replacing active picker title="${activeCommandSearchQuickPick.quickPick.title}"`);
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
  if (options.activeContextKey) {
    await vscode.commands.executeCommand('setContext', options.activeContextKey, true);
    options.debugLog?.(`context ${options.activeContextKey}=true`);
  }
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
    options.debugLog?.(`picker items updated title="${quickPick.title}" query="${query}" count=${candidates.length}`);
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
      options.debugLog?.(`picker accepted title="${quickPick.title}" label="${candidate.label}"`);
      void options.onDidAccept(candidate);
    }

    quickPick.hide();
  });
  quickPick.onDidHide(() => {
    hidden = true;
    options.debugLog?.(`picker hidden title="${quickPick.title}" suppressHideHandler=${quickPickState.suppressHideHandler}`);
    if (activeCommandSearchQuickPick === quickPickState) {
      activeCommandSearchQuickPick = undefined;
    }
    if (options.activeContextKey) {
      void vscode.commands.executeCommand('setContext', options.activeContextKey, false);
      options.debugLog?.(`context ${options.activeContextKey}=false`);
    }
    quickPick.dispose();
    if (!quickPickState.suppressHideHandler) {
      options.onDidHide?.();
    } else {
      options.debugLog?.(`picker hide handler suppressed title="${quickPick.title}"`);
    }
  });

  quickPick.show();
  options.debugLog?.(`picker shown title="${quickPick.title}"`);
  await updateItems('');
  return true;
}
