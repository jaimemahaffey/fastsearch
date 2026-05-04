import * as vscode from 'vscode';

export type FastIndexerConfig = {
  enabled: boolean;
  include: string[];
  exclude: string[];
  ignoreFiles: string[];
  sharedIgnoreFiles: string[];
  maxFileSizeKb: number;
  debounceMs: number;
  symbolFallback: boolean;
  providerFallback: boolean;
  fuzzySearch: boolean;
  completionStyleResults: boolean;
  useRipgrep: boolean;
  useFzf: boolean;
};

const REBUILD_KEYS = new Set([
  'fastIndexer.include',
  'fastIndexer.exclude',
  'fastIndexer.ignoreFiles',
  'fastIndexer.sharedIgnoreFiles',
  'fastIndexer.maxFileSizeKb'
]);

const DEFAULT_INCLUDE = ['**/*'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/.git/**'];

export function readConfig(): FastIndexerConfig {
  const config = vscode.workspace.getConfiguration('fastIndexer');
  const maxFileSizeKb = Math.max(0, config.get<number>('maxFileSizeKb', 512));

  return {
    enabled: config.get<boolean>('enabled', true),
    include: readGlobList(config, 'include', DEFAULT_INCLUDE, { allowEmpty: true }),
    exclude: readGlobList(config, 'exclude', DEFAULT_EXCLUDE, { allowEmpty: true }),
    ignoreFiles: readGlobList(config, 'ignoreFiles', [], { allowEmpty: true }),
    sharedIgnoreFiles: readGlobList(config, 'sharedIgnoreFiles', [], { allowEmpty: true }),
    maxFileSizeKb,
    debounceMs: Math.max(0, config.get<number>('debounceMs', 150)),
    symbolFallback: config.get<boolean>('symbolFallback', true),
    providerFallback: config.get<boolean>('providerFallback', true),
    fuzzySearch: config.get<boolean>('fuzzySearch', true),
    completionStyleResults: config.get<boolean>('completionStyleResults', true),
    useRipgrep: config.get<boolean>('useRipgrep', true),
    useFzf: config.get<boolean>('useFzf', false)
  };
}

export function requiresRebuild(event: vscode.ConfigurationChangeEvent): boolean {
  return [...REBUILD_KEYS].some((key) => event.affectsConfiguration(key));
}

function readGlobList(
  config: vscode.WorkspaceConfiguration,
  key: 'include' | 'exclude' | 'ignoreFiles' | 'sharedIgnoreFiles',
  fallback: string[],
  options: { allowEmpty?: boolean } = {}
): string[] {
  const value = config.get<unknown>(key);
  if (value === undefined) {
    return [...fallback];
  }

  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const patterns = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  if (patterns.length > 0) {
    return patterns;
  }

  return options.allowEmpty ? [] : [...fallback];
}
