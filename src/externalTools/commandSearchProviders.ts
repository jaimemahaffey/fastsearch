import * as vscode from 'vscode';
import type { TextMatch } from '../indexes/textIndex';
import type { CommandSearchCandidate } from '../shared/commandSearch';
import { defaultExternalToolRunner, runExternalTool, type ExternalToolRunner } from './commandSearchTools';

const MAX_EXTERNAL_CANDIDATES = 200;

type RipgrepSearchOptions = {
  enabled: boolean;
};

type FzfSearchOptions = {
  enabled: boolean;
};

type RipgrepMatchEvent = {
  type: 'match';
  data: {
    path?: { text?: string; };
    lines?: { text?: string; };
    line_number?: number;
    submatches?: Array<{ start?: number; }>;
  };
};

export async function searchTextWithRipgrep(
  query: string,
  options: RipgrepSearchOptions,
  runner: ExternalToolRunner = defaultExternalToolRunner
): Promise<TextMatch[]> {
  const needle = query.trim();
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (!needle || workspaceFolders.length === 0) {
    return [];
  }

  const result = await runExternalTool(
    'rg',
    [
      '--json',
      '--line-number',
      '--column',
      '--max-count',
      String(MAX_EXTERNAL_CANDIDATES),
      '--fixed-strings',
      '--smart-case',
      needle,
      ...workspaceFolders.map((folder) => folder.uri.fsPath)
    ],
    {
      enabled: options.enabled,
      allowedExitCodes: [1]
    },
    runner
  );

  if (!result.ok || !result.stdout.trim()) {
    return [];
  }

  const matches: TextMatch[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const event = tryParseRipgrepMatch(line);
    if (!event) {
      continue;
    }

    const filePath = event.data.path?.text;
    if (!filePath) {
      continue;
    }

    const uri = vscode.Uri.file(filePath);
    const preview = (event.data.lines?.text ?? '').trim();
    matches.push({
      relativePath: vscode.workspace.asRelativePath(uri, true),
      uri: uri.toString(),
      line: event.data.line_number ?? 1,
      column: (event.data.submatches?.[0]?.start ?? 0) + 1,
      preview
    });

    if (matches.length >= MAX_EXTERNAL_CANDIDATES) {
      break;
    }
  }

  return matches;
}

export async function narrowCommandSearchCandidatesWithFzf(
  query: string,
  candidates: CommandSearchCandidate[],
  options: FzfSearchOptions,
  runner: ExternalToolRunner = defaultExternalToolRunner
): Promise<CommandSearchCandidate[]> {
  const needle = query.trim();
  if (!options.enabled || !needle || candidates.length < 2) {
    return candidates;
  }

  const input = candidates
    .map((candidate, index) => `${index}\t${candidate.filterText}`)
    .join('\n');
  const result = await runExternalTool(
    'fzf',
    ['--filter', needle, '--delimiter', '\t', '--with-nth', '2..'],
    {
      enabled: true,
      input,
      allowedExitCodes: [1]
    },
    runner
  );

  if (!result.ok) {
    return candidates;
  }

  if (!result.stdout.trim()) {
    return [];
  }

  const narrowed: CommandSearchCandidate[] = [];
  const seen = new Set<number>();

  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const [indexText] = line.split('\t', 1);
    const index = Number.parseInt(indexText ?? '', 10);
    if (Number.isNaN(index) || index < 0 || index >= candidates.length || seen.has(index)) {
      continue;
    }

    seen.add(index);
    narrowed.push(candidates[index]!);
  }

  return narrowed.length > 0 ? narrowed : candidates;
}

function tryParseRipgrepMatch(line: string): RipgrepMatchEvent | undefined {
  try {
    const parsed = JSON.parse(line) as { type?: string; };
    return parsed.type === 'match' ? parsed as RipgrepMatchEvent : undefined;
  } catch {
    return undefined;
  }
}
