import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readConfig, requiresRebuild } from '../../configuration';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('configuration', () => {
  test('reads persisted-index configuration values with sane defaults', () => {
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            enabled: false,
            include: ['src/**/*.ts'],
            exclude: [],
            ignoreFiles: ['.fast-indexer-ignore'],
            sharedIgnoreFiles: ['.config/fast-indexer/shared.ignore'],
            maxFileSizeKb: -1,
            debounceMs: -5,
            symbolFallback: false,
            providerFallback: false,
            fuzzySearch: false,
            completionStyleResults: false,
            useRipgrep: false,
            useFzf: true
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);

    try {
      assert.deepEqual(readConfig(), {
        enabled: false,
        include: ['src/**/*.ts'],
        exclude: [],
        ignoreFiles: ['.fast-indexer-ignore'],
        sharedIgnoreFiles: ['.config/fast-indexer/shared.ignore'],
        maxFileSizeKb: 0,
        debounceMs: 0,
        symbolFallback: false,
        providerFallback: false,
        fuzzySearch: false,
        completionStyleResults: false,
        useRipgrep: false,
        useFzf: true,
        semanticEnrichment: true,
        semanticConcurrency: 2,
        semanticTimeoutMs: 750
      });
    } finally {
      restoreProperty(configPatch);
    }
  });

  test('reads semantic enrichment configuration values with sane defaults', () => {
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue: T) => {
          const values: Record<string, unknown> = {
            semanticEnrichment: false,
            semanticConcurrency: -3,
            semanticTimeoutMs: -10
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);

    try {
      const config = readConfig();

      assert.equal(config.semanticEnrichment, false);
      assert.equal(config.semanticConcurrency, 1);
      assert.equal(config.semanticTimeoutMs, 0);
    } finally {
      restoreProperty(configPatch);
    }
  });

  test('preserves explicit empty include and exclude lists', () => {
    const configPatch = patchProperty(vscode.workspace, 'getConfiguration', (((section?: string) => {
      assert.equal(section, 'fastIndexer');
      return {
        get: <T>(key: string, defaultValue?: T) => {
          const values: Record<string, unknown> = {
            include: [],
            exclude: []
          };

          return (values[key] ?? defaultValue) as T;
        }
      };
    }) as unknown) as typeof vscode.workspace.getConfiguration);

    try {
      assert.deepEqual(readConfig().include, []);
      assert.deepEqual(readConfig().exclude, []);
    } finally {
      restoreProperty(configPatch);
    }
  });

  test('requires rebuild for watched configuration keys', () => {
    const watchedKeys = [
      'fastIndexer.include',
      'fastIndexer.exclude',
      'fastIndexer.ignoreFiles',
      'fastIndexer.sharedIgnoreFiles',
      'fastIndexer.maxFileSizeKb',
      'fastIndexer.semanticEnrichment',
      'fastIndexer.semanticConcurrency',
      'fastIndexer.semanticTimeoutMs'
    ];

    for (const watchedKey of watchedKeys) {
      const event = {
        affectsConfiguration: (key: string) => key === watchedKey
      };

      assert.equal(requiresRebuild(event as never), true, `${watchedKey} should trigger a rebuild`);
    }
  });

  test('does not require rebuild for unrelated configuration keys', () => {
    const event = {
      affectsConfiguration: (key: string) => key === 'fastIndexer.debounceMs'
    };

    assert.equal(requiresRebuild(event as never), false);
  });
});
