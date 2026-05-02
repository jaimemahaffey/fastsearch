import * as vscode from 'vscode';

export type FastIndexerConfig = {
  enabled: boolean;
  maxFileSizeKb: number;
  debounceMs: number;
};

export function readConfig(): FastIndexerConfig {
  const config = vscode.workspace.getConfiguration('fastIndexer');
  return {
    enabled: config.get<boolean>('enabled', true),
    maxFileSizeKb: config.get<number>('maxFileSizeKb', 512),
    debounceMs: config.get<number>('debounceMs', 150)
  };
}
