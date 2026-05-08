import * as assert from 'node:assert/strict';
import { SemanticIndex, createSymbolSemanticKey } from '../../semantics/semanticIndex';
import type { SemanticMetadata } from '../../semantics/semanticTypes';

suite('semantic enrichment index', () => {
  test('stores and retrieves semantic metadata by relative path and symbol location', () => {
    const index = new SemanticIndex();
    const metadata: SemanticMetadata = {
      definition: { uri: 'file:///workspace/src/alpha.ts', line: 3, column: 2 },
      implementationCount: 2,
      referenceCount: 4,
      provider: 'vscode',
      status: 'enriched',
      confidence: 1,
      enrichedAt: 123
    };

    index.set('src/alpha.ts', 'Alpha:5:7:class', metadata);

    assert.deepEqual(index.get('src/alpha.ts', 'Alpha:5:7:class'), metadata);
    assert.equal(index.get('src/missing.ts', 'Alpha:5:7:class'), undefined);
  });

  test('serializes by file and restores entries without sharing mutable arrays', () => {
    const index = new SemanticIndex();
    index.set('src/alpha.ts', 'Alpha:5:7:class', {
      provider: 'vscode',
      status: 'failed',
      confidence: 0,
      enrichedAt: 456
    });

    const serialized = index.allByFile();
    const restored = new SemanticIndex();
    restored.replaceForFile(serialized[0]!.relativePath, serialized[0]!.entries);

    serialized[0]!.entries.length = 0;

    assert.equal(restored.allByFile()[0]?.entries.length, 1);
    assert.equal(restored.get('src/alpha.ts', 'Alpha:5:7:class')?.status, 'failed');
  });

  test('creates stable semantic keys from symbol identity fields', () => {
    const symbol = {
      name: 'Alpha',
      kind: 5,
      containerName: 'services',
      uri: 'file:///workspace/src/alpha.ts',
      startLine: 8,
      startColumn: 2,
      approximate: false
    };
    assert.equal(createSymbolSemanticKey(symbol), 'Alpha:5:services:8:2');
  });
});
