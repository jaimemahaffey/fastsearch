import * as vscode from 'vscode';

export type FastIndexerConfig = {
  enabled: boolean;
  include: string[];
  exclude: string[];
  maxFileSizeKb: number;
  debounceMs: number;
  symbolFallback: boolean;
  providerFallback: boolean;
};

const REBUILD_KEYS = new Set([
  'fastIndexer.include',
  'fastIndexer.exclude',
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
    maxFileSizeKb,
    debounceMs: Math.max(0, config.get<number>('debounceMs', 150)),
    symbolFallback: config.get<boolean>('symbolFallback', true),
    providerFallback: config.get<boolean>('providerFallback', true)
  };
}

export function requiresRebuild(event: vscode.ConfigurationChangeEvent): boolean {
  return [...REBUILD_KEYS].some((key) => event.affectsConfiguration(key));
}

function readGlobList(
  config: vscode.WorkspaceConfiguration,
  key: 'include' | 'exclude',
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
