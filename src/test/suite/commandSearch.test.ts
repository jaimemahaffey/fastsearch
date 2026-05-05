import * as assert from 'node:assert/strict';
import type { DiscoveryResult } from '../../commands/findUsages';
import { type CommandSearchProvider, collectAvailableProviderResults, getCommandSearchIcon, getCommandSearchProvenanceIcon, rankCommandSearchCandidates, toDiscoverySearchCandidate, toFileSearchCandidate, toSymbolSearchCandidate, toTextSearchCandidate } from '../../shared/commandSearch';
import type { FileRecord } from '../../shared/types';
import type { TextMatch } from '../../indexes/textIndex';
import type { SymbolRecord } from '../../indexes/symbolIndex';

suite('commandSearch', () => {
  test('normalizes built-in result shapes into shared command search candidates', () => {
    const fileRecord: FileRecord = {
      relativePath: 'src/app/main.ts',
      uri: 'file:///workspace/src/app/main.ts',
      basename: 'main.ts',
      extension: '.ts',
      tokens: ['src', 'app', 'main', 'ts']
    };
    const textMatch: TextMatch = {
      relativePath: 'src/app/main.ts',
      uri: fileRecord.uri,
      line: 7,
      column: 3,
      preview: 'const alpha = beta;'
    };
    const symbolRecord: SymbolRecord = {
      name: 'AlphaService',
      kind: 5,
      containerName: 'services',
      uri: fileRecord.uri,
      startLine: 10,
      startColumn: 2,
      approximate: false
    };
    const discoveryResult: DiscoveryResult = {
      uri: fileRecord.uri,
      line: 14,
      approximate: true
    };

    assert.deepEqual(toFileSearchCandidate(fileRecord), {
      source: 'file',
      label: 'main.ts',
      description: 'src/app/main.ts',
      detail: fileRecord.uri,
      filterText: 'main.ts src/app/main.ts',
      uri: fileRecord.uri,
      approximate: false
    });
    assert.deepEqual(toTextSearchCandidate(textMatch), {
      source: 'text',
      label: 'src/app/main.ts:7',
      description: 'const alpha = beta;',
      detail: fileRecord.uri,
      filterText: 'src/app/main.ts const alpha = beta;',
      uri: fileRecord.uri,
      line: 6,
      column: 2,
      approximate: false
    });
    assert.deepEqual(toSymbolSearchCandidate(symbolRecord), {
      source: 'symbol',
      label: 'AlphaService',
      description: 'services',
      detail: fileRecord.uri,
      filterText: 'AlphaService services',
      uri: fileRecord.uri,
      line: 10,
      column: 2,
      approximate: false
    });
    assert.deepEqual(toDiscoverySearchCandidate('usage', discoveryResult), {
      source: 'usage',
      label: 'file:///workspace/src/app/main.ts:15',
      description: undefined,
      detail: fileRecord.uri,
      filterText: 'file:///workspace/src/app/main.ts',
      uri: fileRecord.uri,
      line: 14,
      approximate: true
    });
  });

  test('uses distinct subtle icons for provider-backed and approximate command results', () => {
    const providerIcon = getCommandSearchProvenanceIcon({ approximate: false });
    const approximateIcon = getCommandSearchProvenanceIcon({ approximate: true });

    assert.equal(providerIcon.id, 'circle-filled');
    assert.equal(providerIcon.color?.id, 'testing.iconPassed');
    assert.equal(approximateIcon.id, 'circle-small');
    assert.equal(approximateIcon.color?.id, 'problemsWarningIcon.foreground');
  });

  test('uses compact source icons for file and text command results', () => {
    assert.equal(getCommandSearchIcon({ source: 'file', approximate: false }).id, 'file');
    assert.equal(getCommandSearchIcon({ source: 'text', approximate: false }).id, 'search');
    assert.equal(getCommandSearchIcon({ source: 'symbol', approximate: false }).id, 'circle-filled');
    assert.equal(getCommandSearchIcon({ source: 'usage', approximate: true }).id, 'circle-small');
  });

  test('collects results from available providers only', async () => {
    const calls: string[] = [];
    const providers: Array<CommandSearchProvider<{ query: string }>> = [
      {
        name: 'built-in',
        isAvailable: () => true,
        provide: async (context) => {
          calls.push(`built-in:${context.query}`);
          return [{
            source: 'file',
            label: 'main.ts',
            detail: 'file:///workspace/src/app/main.ts',
            filterText: 'main.ts',
            uri: 'file:///workspace/src/app/main.ts',
            approximate: false
          }];
        }
      },
      {
        name: 'fzf',
        isAvailable: () => false,
        provide: async () => {
          calls.push('fzf');
          return [];
        }
      }
    ];

    const results = await collectAvailableProviderResults(providers, { query: 'main' });

    assert.deepEqual(calls, ['built-in:main']);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.label, 'main.ts');
  });

  test('supports non-contiguous fuzzy matches when ranking command candidates', () => {
    const results = rankCommandSearchCandidates('gtf', [
      {
        source: 'file',
        label: 'Go To Text',
        detail: 'file:///workspace/src/text.ts',
        filterText: 'go to text src/text.ts',
        uri: 'file:///workspace/src/text.ts',
        approximate: false
      },
      {
        source: 'file',
        label: 'Go To File',
        detail: 'file:///workspace/src/file.ts',
        filterText: 'go to file src/file.ts',
        uri: 'file:///workspace/src/file.ts',
        approximate: false
      }
    ]);

    assert.deepEqual(results.map((result) => result.label), ['Go To File']);
  });

  test('orders exact, prefix, and substring matches by strength', () => {
    const results = rankCommandSearchCandidates('file', [
      {
        source: 'file',
        label: 'Go To File',
        detail: 'file:///workspace/src/go-to-file.ts',
        filterText: 'go to file',
        uri: 'file:///workspace/src/go-to-file.ts',
        approximate: false
      },
      {
        source: 'file',
        label: 'File Search',
        detail: 'file:///workspace/src/file-search.ts',
        filterText: 'file search',
        uri: 'file:///workspace/src/file-search.ts',
        approximate: false
      },
      {
        source: 'file',
        label: 'file',
        detail: 'file:///workspace/src/file.ts',
        filterText: 'file',
        uri: 'file:///workspace/src/file.ts',
        approximate: false
      }
    ]);

    assert.deepEqual(results.map((result) => result.label), [
      'file',
      'File Search',
      'Go To File'
    ]);
  });
});
