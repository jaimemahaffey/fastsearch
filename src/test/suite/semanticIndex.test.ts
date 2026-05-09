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

  test('set() does not share nested target objects with input metadata', () => {
    const index = new SemanticIndex();
    const inputMetadata: SemanticMetadata = {
      definition: { uri: 'file:///workspace/src/alpha.ts', line: 3, column: 2 },
      declaration: { uri: 'file:///workspace/src/alpha.d.ts', line: 1, column: 0 },
      typeDefinition: { uri: 'file:///workspace/src/types.ts', line: 5, column: 4 },
      provider: 'vscode',
      status: 'enriched',
      confidence: 1,
      enrichedAt: 123
    };

    index.set('src/alpha.ts', 'Alpha:5:7:class', inputMetadata);

    // Mutate input nested objects
    inputMetadata.definition!.line = 999;
    inputMetadata.declaration!.column = 888;
    inputMetadata.typeDefinition!.uri = 'file:///mutated.ts';

    const stored = index.get('src/alpha.ts', 'Alpha:5:7:class');
    assert.equal(stored?.definition?.line, 3, 'stored definition should not be affected');
    assert.equal(stored?.declaration?.column, 0, 'stored declaration should not be affected');
    assert.equal(stored?.typeDefinition?.uri, 'file:///workspace/src/types.ts', 'stored typeDefinition should not be affected');
  });

  test('get() does not share nested target objects with stored metadata', () => {
    const index = new SemanticIndex();
    index.set('src/alpha.ts', 'Alpha:5:7:class', {
      definition: { uri: 'file:///workspace/src/alpha.ts', line: 3, column: 2 },
      declaration: { uri: 'file:///workspace/src/alpha.d.ts', line: 1, column: 0 },
      provider: 'vscode',
      status: 'enriched',
      confidence: 1,
      enrichedAt: 123
    });

    const retrieved1 = index.get('src/alpha.ts', 'Alpha:5:7:class')!;

    // Mutate retrieved nested objects
    retrieved1.definition!.line = 777;
    retrieved1.declaration!.uri = 'file:///mutated.ts';

    const retrieved2 = index.get('src/alpha.ts', 'Alpha:5:7:class')!;
    assert.equal(retrieved2.definition?.line, 3, 'second retrieval should not be affected');
    assert.equal(retrieved2.declaration?.uri, 'file:///workspace/src/alpha.d.ts', 'second retrieval should not be affected');
  });

  test('allByFile() does not share nested target objects with stored metadata', () => {
    const index = new SemanticIndex();
    index.set('src/alpha.ts', 'Alpha:5:7:class', {
      definition: { uri: 'file:///workspace/src/alpha.ts', line: 3, column: 2 },
      typeDefinition: { uri: 'file:///workspace/src/types.ts', line: 5, column: 4 },
      provider: 'vscode',
      status: 'enriched',
      confidence: 1,
      enrichedAt: 123
    });

    const serialized = index.allByFile();

    // Mutate serialized nested objects
    serialized[0]!.entries[0]!.metadata.definition!.column = 666;
    serialized[0]!.entries[0]!.metadata.typeDefinition!.line = 555;

    const retrieved = index.get('src/alpha.ts', 'Alpha:5:7:class')!;
    assert.equal(retrieved.definition?.column, 2, 'stored definition should not be affected by serialization mutation');
    assert.equal(retrieved.typeDefinition?.line, 5, 'stored typeDefinition should not be affected by serialization mutation');
  });

  test('replaceForFile() does not share nested target objects with input entries', () => {
    const index = new SemanticIndex();
    const inputEntries = [
      {
        key: 'Alpha:5:7:class',
        metadata: {
          definition: { uri: 'file:///workspace/src/alpha.ts', line: 3, column: 2 },
          declaration: { uri: 'file:///workspace/src/alpha.d.ts', line: 1, column: 0 },
          provider: 'vscode' as const,
          status: 'enriched' as const,
          confidence: 1,
          enrichedAt: 123
        }
      }
    ];

    index.replaceForFile('src/alpha.ts', inputEntries);

    // Mutate input nested objects
    inputEntries[0]!.metadata.definition!.line = 444;
    inputEntries[0]!.metadata.declaration!.column = 333;

    const stored = index.get('src/alpha.ts', 'Alpha:5:7:class')!;
    assert.equal(stored.definition?.line, 3, 'stored definition should not be affected by input mutation');
    assert.equal(stored.declaration?.column, 0, 'stored declaration should not be affected by input mutation');
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
