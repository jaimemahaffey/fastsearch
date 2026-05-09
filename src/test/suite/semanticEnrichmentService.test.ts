import * as assert from 'assert';
import type { SymbolRecord } from '../../indexes/symbolIndex';
import { SemanticIndex, createSymbolSemanticKey } from '../../semantics/semanticIndex';
import type { SemanticTarget } from '../../semantics/semanticTypes';
import type { ProviderCallResult } from '../../bridge/providerBridge';
import type { DiscoveryResult } from '../../commands/findUsages';
import { SemanticEnrichmentService } from '../../semantics/semanticEnrichmentService';

suite('semantic enrichment service', () => {
  test('enriches queued symbols in the background without awaiting queue work', async () => {
    const semanticIndex = new SemanticIndex();
    const providers = createMockProviders();
    let time = 1000;

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 5000,
      providers,
      now: () => time
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      }
    ];

    // Enqueue should return immediately
    service.enqueueFile('test.ts', symbols, 1);

    // The symbol should not be enriched yet (background work not awaited)
    const keyBefore = createSymbolSemanticKey(symbols[0]);
    const metadataBefore = semanticIndex.get('test.ts', keyBefore);
    assert.strictEqual(metadataBefore, undefined, 'Metadata should not exist immediately after enqueue');

    // Wait for background work to complete
    await service.idle();

    // Now the symbol should be enriched
    const key = createSymbolSemanticKey(symbols[0]);
    const metadata = semanticIndex.get('test.ts', key);
    assert.ok(metadata, 'Metadata should exist after idle');
    assert.strictEqual(metadata.status, 'enriched');
    assert.strictEqual(metadata.confidence, 1);
    assert.strictEqual(metadata.enrichedAt, 1000);
    assert.deepStrictEqual(metadata.definition, { uri: 'file:///def.ts', line: 5, column: 10 });
  });

  test('marks stale generation work as cancelled instead of writing metadata', async () => {
    const semanticIndex = new SemanticIndex();
    const providers = createMockProviders();
    let time = 1000;

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 5000,
      providers,
      now: () => time
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      }
    ];

    // Enqueue generation 1
    service.enqueueFile('test.ts', symbols, 1);

    // Cancel generation 1 before it completes
    service.cancelGeneration(1);

    // Wait for any queued work
    await service.idle();

    // No metadata should be written for cancelled generation
    const key = createSymbolSemanticKey(symbols[0]);
    const metadata = semanticIndex.get('test.ts', key);
    assert.strictEqual(metadata, undefined, 'No metadata should be written for cancelled generation');
  });

  test('marks timeout status when a provider exceeds timeout', async () => {
    const semanticIndex = new SemanticIndex();
    let time = 1000;

    // Create providers that will timeout
    const providers = {
      getDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        // Simulate slow provider (never resolves)
        return new Promise(() => {});
      },
      getDeclarations: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        return { ok: true, value: [] };
      },
      getTypeDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        return { ok: true, value: [] };
      },
      getImplementations: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
        return [];
      },
      getReferences: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
        return [];
      },
      getHoverSummary: async (uri: any, position: any): Promise<ProviderCallResult<string | undefined>> => {
        return { ok: true, value: undefined };
      }
    };

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 100, // Very short timeout
      providers,
      now: () => time
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      }
    ];

    service.enqueueFile('test.ts', symbols, 1);

    await service.idle();

    // Metadata should have timeout status
    const key = createSymbolSemanticKey(symbols[0]);
    const metadata = semanticIndex.get('test.ts', key);
    assert.ok(metadata, 'Metadata should exist');
    assert.strictEqual(metadata.status, 'timeout', 'Status should be timeout');
  });

  test('skips approximate symbols', async () => {
    const semanticIndex = new SemanticIndex();
    const providers = createMockProviders();

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 5000,
      providers,
      now: () => 1000
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: true // Approximate symbol
      }
    ];

    service.enqueueFile('test.ts', symbols, 1);
    await service.idle();

    // No metadata should be written for approximate symbols
    const key = createSymbolSemanticKey(symbols[0]);
    const metadata = semanticIndex.get('test.ts', key);
    assert.strictEqual(metadata, undefined, 'No metadata should be written for approximate symbols');
  });

  test('does nothing when disabled', async () => {
    const semanticIndex = new SemanticIndex();
    const providers = createMockProviders();

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: false, // Disabled
      concurrency: 1,
      timeoutMs: 5000,
      providers,
      now: () => 1000
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      }
    ];

    service.enqueueFile('test.ts', symbols, 1);
    await service.idle();

    // No metadata should be written when disabled
    const key = createSymbolSemanticKey(symbols[0]);
    const metadata = semanticIndex.get('test.ts', key);
    assert.strictEqual(metadata, undefined, 'No metadata should be written when disabled');
  });

  test('clear empties the queue', async () => {
    const semanticIndex = new SemanticIndex();

    // Create slow providers to give us time to clear
    let providerStarted = false;
    let shouldResolve: (() => void) | null = null;
    const providerPromise = new Promise<void>((resolve) => {
      shouldResolve = resolve;
    });

    const providers = {
      getDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        providerStarted = true;
        await providerPromise; // Block until we signal
        return { ok: true, value: [{ uri: 'file:///def.ts', line: 5, column: 10 }] };
      },
      getDeclarations: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        return { ok: true, value: [] };
      },
      getTypeDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        return { ok: true, value: [] };
      },
      getImplementations: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
        return [];
      },
      getReferences: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
        return [];
      },
      getHoverSummary: async (uri: any, position: any): Promise<ProviderCallResult<string | undefined>> => {
        return { ok: true, value: undefined };
      }
    };

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 5000,
      providers,
      now: () => 1000
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      },
      {
        name: 'anotherFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 20,
        startColumn: 5,
        approximate: false
      }
    ];

    service.enqueueFile('test.ts', symbols, 1);

    // Wait for provider to start
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(providerStarted, 'Provider should have started');

    // Clear the queue while first symbol is still processing
    service.clear();

    // Let the provider complete
    shouldResolve!();

    await service.idle();

    // First symbol may or may not be written (it was already processing)
    // But second symbol should NOT be written because queue was cleared
    const key2 = createSymbolSemanticKey(symbols[1]);
    const metadata2 = semanticIndex.get('test.ts', key2);
    assert.strictEqual(metadata2, undefined, 'Second symbol should not be enriched after clear');
  });

  test('clear empties the queue and clears stored metadata from SemanticIndex', async () => {
    const semanticIndex = new SemanticIndex();
    const providers = createMockProviders();

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 5000,
      providers,
      now: () => 1000
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      }
    ];

    // Enqueue and let it complete
    service.enqueueFile('test.ts', symbols, 1);
    await service.idle();

    // Verify metadata was written
    const key = createSymbolSemanticKey(symbols[0]);
    const metadataBefore = semanticIndex.get('test.ts', key);
    assert.ok(metadataBefore, 'Metadata should exist before clear');

    // Now clear
    service.clear();

    // Verify metadata was cleared from SemanticIndex
    const metadataAfter = semanticIndex.get('test.ts', key);
    assert.strictEqual(metadataAfter, undefined, 'Metadata should be cleared from SemanticIndex');
  });

  test('clear clears cancelled generation tracking', async () => {
    const semanticIndex = new SemanticIndex();
    const providers = createMockProviders();

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 5000,
      providers,
      now: () => 1000
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      }
    ];

    // Cancel generation 1 and 2
    service.cancelGeneration(1);
    service.cancelGeneration(2);

    // Enqueue work for cancelled generation 1 - should be skipped
    service.enqueueFile('test.ts', symbols, 1);
    await service.idle();

    const key = createSymbolSemanticKey(symbols[0]);
    const metadataBefore = semanticIndex.get('test.ts', key);
    assert.strictEqual(metadataBefore, undefined, 'Gen 1 should be cancelled, no metadata');

    // Clear everything including cancelled generations
    service.clear();

    // Now enqueue work for previously-cancelled generation 1 - should succeed after clear
    service.enqueueFile('test.ts', symbols, 1);
    await service.idle();

    const metadataAfter = semanticIndex.get('test.ts', key);
    assert.ok(metadataAfter, 'Gen 1 should work after clear removes cancelled tracking');
    assert.strictEqual(metadataAfter.status, 'enriched');
  });

  test('timeoutMs = 0 disables timeout and allows enrichment to complete', async () => {
    const semanticIndex = new SemanticIndex();
    let time = 1000;

    // Create providers that take some time but will eventually complete
    let definitionsCallCount = 0;
    const providers = {
      getDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        definitionsCallCount++;
        // Simulate work that takes longer than 0ms
        await new Promise(resolve => setTimeout(resolve, 50));
        return { ok: true, value: [{ uri: 'file:///def.ts', line: 5, column: 10 }] };
      },
      getDeclarations: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        return { ok: true, value: [] };
      },
      getTypeDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
        return { ok: true, value: [] };
      },
      getImplementations: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
        return [];
      },
      getReferences: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
        return [];
      },
      getHoverSummary: async (uri: any, position: any): Promise<ProviderCallResult<string | undefined>> => {
        return { ok: true, value: undefined };
      }
    };

    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 0, // Timeout disabled
      providers,
      now: () => time
    });

    const symbols: SymbolRecord[] = [
      {
        name: 'myFunction',
        kind: 1,
        containerName: undefined,
        uri: 'file:///test.ts',
        startLine: 10,
        startColumn: 5,
        approximate: false
      }
    ];

    service.enqueueFile('test.ts', symbols, 1);
    await service.idle();

    // Verify the provider was called and completed successfully
    assert.strictEqual(definitionsCallCount, 1, 'Provider should have been called once');

    // Metadata should be enriched, not timed out
    const key = createSymbolSemanticKey(symbols[0]);
    const metadata = semanticIndex.get('test.ts', key);
    assert.ok(metadata, 'Metadata should exist');
    assert.strictEqual(metadata.status, 'enriched', 'Status should be enriched, not timeout');
    assert.strictEqual(metadata.confidence, 1);
    assert.deepStrictEqual(metadata.definition, { uri: 'file:///def.ts', line: 5, column: 10 });
  });
});

function createMockProviders() {
  return {
    getDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
      return { ok: true, value: [{ uri: 'file:///def.ts', line: 5, column: 10 }] };
    },
    getDeclarations: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
      return { ok: true, value: [{ uri: 'file:///decl.ts', line: 3, column: 2 }] };
    },
    getTypeDefinitions: async (uri: any, position: any): Promise<ProviderCallResult<SemanticTarget[]>> => {
      return { ok: true, value: [{ uri: 'file:///type.ts', line: 8, column: 0 }] };
    },
    getImplementations: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
      return [
        { uri: 'file:///impl1.ts', line: 10, approximate: false },
        { uri: 'file:///impl2.ts', line: 20, approximate: false }
      ];
    },
    getReferences: async (uri: any, position: any): Promise<DiscoveryResult[]> => {
      return [
        { uri: 'file:///ref1.ts', line: 5, approximate: false },
        { uri: 'file:///ref2.ts', line: 15, approximate: false },
        { uri: 'file:///ref3.ts', line: 25, approximate: false }
      ];
    },
    getHoverSummary: async (uri: any, position: any): Promise<ProviderCallResult<string | undefined>> => {
      return { ok: true, value: 'This is a test function' };
    }
  };
}
