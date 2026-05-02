import * as vscode from 'vscode';

export type FastIndexerConfig = {
  enabled: boolean;
  maxFileSizeKb: number;
  debounceMs: number;
};

export function readConfig(): FastIndexerConfig {
  const config = vscode.workspace.getConfiguration('fastIndexer');
  const maxFileSizeKb = Math.max(0, config.get<number>('maxFileSizeKb', 512));

  return {
    enabled: config.get<boolean>('enabled', true),
    maxFileSizeKb,
    debounceMs: config.get<number>('debounceMs', 150)
  };
}
