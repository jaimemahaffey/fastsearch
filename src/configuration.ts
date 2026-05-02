import * as vscode from 'vscode';

export type FastIndexerConfig = {
  enabled: boolean;
  maxFileSizeKb: number;
  debounceMs: number;
};

const REBUILD_KEYS = new Set([
  'fastIndexer.include',
  'fastIndexer.exclude',
  'fastIndexer.maxFileSizeKb',
  'fastIndexer.symbolFallback'
]);

export function readConfig(): FastIndexerConfig {
  const config = vscode.workspace.getConfiguration('fastIndexer');
  const maxFileSizeKb = Math.max(0, config.get<number>('maxFileSizeKb', 512));

  return {
    enabled: config.get<boolean>('enabled', true),
    maxFileSizeKb,
    debounceMs: config.get<number>('debounceMs', 150)
  };
}

export function requiresRebuild(event: vscode.ConfigurationChangeEvent): boolean {
  return [...REBUILD_KEYS].some((key) => event.affectsConfiguration(key));
}
