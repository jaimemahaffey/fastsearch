import * as assert from 'node:assert/strict';
import type { DiscoveryResult } from '../../commands/findUsages';
import { type CommandSearchProvider, collectAvailableProviderResults, getCommandSearchIcon, getCommandSearchProvenanceIcon, getSemanticSymbolDetail, rankCommandSearchCandidates, toDiscoverySearchCandidate, toFileSearchCandidate, toSymbolSearchCandidate, toTextSearchCandidate } from '../../shared/commandSearch';
import type { FileRecord } from '../../shared/types';
import type { TextMatch } from '../../indexes/textIndex';
import type { SymbolRecord } from '../../indexes/symbolIndex';
import type { SemanticMetadata } from '../../semantics/semanticTypes';

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

    const vscode = require('vscode');
    const displayPath = vscode.Uri.parse(fileRecord.uri).fsPath;
    assert.deepEqual(toFileSearchCandidate(fileRecord), {
      source: 'file',
      label: 'main.ts',
      description: 'src/app/main.ts',
      detail: displayPath,
      filterText: 'main.ts src/app/main.ts',
      uri: fileRecord.uri,
      approximate: false
    });
    assert.deepEqual(toTextSearchCandidate(textMatch), {
      source: 'text',
      label: 'src/app/main.ts:7',
      description: 'const alpha = beta;',
      detail: displayPath,
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
      detail: displayPath,
      filterText: 'AlphaService services',
      uri: fileRecord.uri,
      line: 10,
      column: 2,
      approximate: false
    });
    assert.deepEqual(toDiscoverySearchCandidate('usage', discoveryResult), {
      source: 'usage',
      label: `${fileRecord.uri}:15`,
      description: undefined,
      detail: displayPath,
      filterText: fileRecord.uri,
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

  test('formats semantic symbol detail with references, implementations, and provider', () => {
    const semanticMetadata: SemanticMetadata = {
      definition: { uri: 'file:///workspace/src/app/main.ts', line: 10, column: 2 },
      implementationCount: 3,
      referenceCount: 7,
      provider: 'vscode',
      status: 'enriched',
      confidence: 1,
      enrichedAt: 123
    };

    const vscode = require('vscode');
    const displayPath = vscode.Uri.parse('file:///workspace/src/app/main.ts').fsPath;
    const detail = getSemanticSymbolDetail('file:///workspace/src/app/main.ts', semanticMetadata);

    assert.equal(detail, `${displayPath} • 7 refs • 3 impls • vscode`);
  });

  test('enriches symbol search candidates with semantic metadata and uses cleaned display path', () => {
    const symbolRecord: SymbolRecord = {
      name: 'AlphaService',
      kind: 5,
      containerName: 'services',
      uri: 'file:///workspace/src/app/main.ts',
      startLine: 10,
      startColumn: 2,
      approximate: false
    };
    const semanticMetadata: SemanticMetadata = {
      definition: { uri: 'file:///workspace/src/app/main.ts', line: 10, column: 2 },
      implementationCount: 3,
      referenceCount: 7,
      provider: 'vscode',
      status: 'enriched',
      confidence: 1,
      enrichedAt: 123
    };

    const candidate = toSymbolSearchCandidate(symbolRecord, semanticMetadata);

    const vscode = require('vscode');
    const displayPath = vscode.Uri.parse(symbolRecord.uri).fsPath;

    assert.equal(candidate.source, 'symbol');
    assert.equal(candidate.label, 'AlphaService');
    assert.equal(candidate.description, 'services');
    assert.equal(candidate.detail, `${displayPath} • 7 refs • 3 impls • vscode`);
    assert.equal(candidate.filterText, 'AlphaService services');
    assert.equal(candidate.uri, 'file:///workspace/src/app/main.ts');
    assert.equal(candidate.line, 10);
    assert.equal(candidate.column, 2);
    assert.equal(candidate.approximate, false);
    assert.equal(candidate.semanticConfidence, 1);
  });

  test('non-enriched semantic metadata keeps semanticConfidence and uses cleaned display path', () => {
    const symbolRecord: SymbolRecord = {
      name: 'BetaService',
      kind: 5,
      containerName: 'services',
      uri: 'file:///workspace/src/app/service.ts',
      startLine: 20,
      startColumn: 4,
      approximate: false
    };
    const semanticMetadata: SemanticMetadata = {
      definition: { uri: 'file:///workspace/src/app/service.ts', line: 20, column: 4 },
      implementationCount: undefined,
      referenceCount: undefined,
      provider: 'vscode',
      status: 'pending',
      confidence: 0.8,
      enrichedAt: 456
    };

    const vscode = require('vscode');
    const displayPath = vscode.Uri.parse(symbolRecord.uri).fsPath;
    const candidate = toSymbolSearchCandidate(symbolRecord, semanticMetadata);

    assert.equal(candidate.detail, displayPath);
    assert.equal(candidate.semanticConfidence, 0.8);
  });

  test('getCommandSearchDisplayPath leaves non-file URIs unchanged', () => {
    const nonFileUri = 'git:/workspace/src/app/main.ts';
    const { getCommandSearchDisplayPath } = require('../../shared/commandSearch');
    assert.equal(getCommandSearchDisplayPath(nonFileUri), nonFileUri);
  });

});
