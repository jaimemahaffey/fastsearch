# Semantic Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VS Code provider-backed semantic enrichment over FastSearch's existing indexes without slowing activation or baseline search.

**Architecture:** Keep file, text, and symbol indexes as the fast baseline. Add a VS Code-native semantic bridge, a companion semantic metadata index, and a bounded background enrichment service that decorates symbol candidates while preserving provider-first command behavior.

**Tech Stack:** TypeScript, VS Code extension API command providers, Mocha integration tests, existing patched VS Code API test helpers, npm scripts.

---

## File Structure

- Create `src/semantics/semanticTypes.ts`: shared semantic target, status, metadata, and config option types.
- Create `src/semantics/semanticIndex.ts`: companion in-memory semantic metadata index keyed by workspace-relative file and symbol location.
- Create `src/semantics/semanticEnrichmentService.ts`: bounded background scheduler for provider-backed semantic enrichment.
- Create `src/test/suite/providerBridge.test.ts`: tests for typed semantic provider wrappers and failure results.
- Create `src/test/suite/semanticIndex.test.ts`: tests for semantic metadata storage, lookup, clearing, and serialization.
- Create `src/test/suite/semanticEnrichmentService.test.ts`: tests for background scheduling, concurrency, timeout, stale generation, and failure behavior.
- Modify `src/bridge/providerBridge.ts`: add typed semantic provider wrappers while keeping existing document symbol, reference, and implementation APIs.
- Modify `src/configuration.ts`: add semantic enrichment settings and rebuild-trigger keys.
- Modify `package.json`: contribute semantic settings.
- Modify `src/indexes/symbolIndex.ts`: add stable symbol keys and semantic-aware search ordering hooks.
- Modify `src/shared/commandSearch.ts`: shape symbol candidates with semantic metadata and richer details.
- Modify `src/commands/goToSymbol.ts`: pass semantic metadata into candidate shaping.
- Modify `src/commands/cycleSearchMode.ts`: pass semantic metadata through symbol mode.
- Modify `src/core/persistenceStore.ts`: persist semantic metadata with the workspace snapshot.
- Modify `src/extension.ts`: create, clear, hydrate, schedule, and persist semantic metadata without awaiting background enrichment during activation.
- Modify `src/test/suite/configuration.test.ts`: cover semantic config defaults and rebuild keys.
- Modify `src/test/suite/commandSearch.test.ts`: cover semantic-aware symbol candidate detail and ranking.
- Modify `src/test/suite/extension.test.ts`: cover activation responsiveness and persistence with slow semantic providers.

## Commands

- Full verification: `npm test`
- Faster type/build check while iterating: `npm run typecheck; npm run compile`
- Single test suite by grep: `$env:MOCHA_GREP='semantic enrichment'; npm test`

---

### Task 1: Add Semantic Types and Configuration

**Files:**
- Create: `src/semantics/semanticTypes.ts`
- Modify: `src/configuration.ts`
- Modify: `package.json`
- Test: `src/test/suite/configuration.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Add this test to `src/test/suite/configuration.test.ts` after the existing `reads persisted-index configuration values with sane defaults` test:

```ts
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
```

Update the watched-key test in the same file so `watchedKeys` is:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='configuration'; npm test
```

Expected: FAIL because `FastIndexerConfig` does not include semantic fields and `readConfig()` does not read them.

- [ ] **Step 3: Add semantic shared types**

Create `src/semantics/semanticTypes.ts`:

```ts
export type SemanticTarget = {
  uri: string;
  line: number;
  column: number;
};

export type SemanticStatus = 'pending' | 'enriched' | 'missing-provider' | 'failed' | 'timeout' | 'cancelled';

export type SemanticMetadata = {
  definition?: SemanticTarget;
  declaration?: SemanticTarget;
  typeDefinition?: SemanticTarget;
  implementationCount?: number;
  referenceCount?: number;
  hoverSummary?: string;
  provider: 'vscode';
  status: SemanticStatus;
  confidence: number;
  enrichedAt: number;
};

export type SemanticEnrichmentConfig = {
  semanticEnrichment: boolean;
  semanticConcurrency: number;
  semanticTimeoutMs: number;
};
```

- [ ] **Step 4: Add semantic settings to configuration**

Modify `src/configuration.ts`:

```ts
export type FastIndexerConfig = {
  enabled: boolean;
  include: string[];
  exclude: string[];
  ignoreFiles: string[];
  sharedIgnoreFiles: string[];
  maxFileSizeKb: number;
  debounceMs: number;
  symbolFallback: boolean;
  providerFallback: boolean;
  fuzzySearch: boolean;
  completionStyleResults: boolean;
  useRipgrep: boolean;
  useFzf: boolean;
  semanticEnrichment: boolean;
  semanticConcurrency: number;
  semanticTimeoutMs: number;
};
```

Update `REBUILD_KEYS`:

```ts
const REBUILD_KEYS = new Set([
  'fastIndexer.include',
  'fastIndexer.exclude',
  'fastIndexer.ignoreFiles',
  'fastIndexer.sharedIgnoreFiles',
  'fastIndexer.maxFileSizeKb',
  'fastIndexer.semanticEnrichment',
  'fastIndexer.semanticConcurrency',
  'fastIndexer.semanticTimeoutMs'
]);
```

Update the returned object in `readConfig()`:

```ts
    useRipgrep: config.get<boolean>('useRipgrep', true),
    useFzf: config.get<boolean>('useFzf', false),
    semanticEnrichment: config.get<boolean>('semanticEnrichment', true),
    semanticConcurrency: Math.max(1, config.get<number>('semanticConcurrency', 2)),
    semanticTimeoutMs: Math.max(0, config.get<number>('semanticTimeoutMs', 750))
```

- [ ] **Step 5: Contribute semantic settings in package metadata**

Add these properties in `package.json` under `contributes.configuration.properties` after `fastIndexer.useFzf`:

```json
        "fastIndexer.semanticEnrichment": {
          "type": "boolean",
          "default": true,
          "description": "Enable background semantic enrichment using VS Code language providers."
        },
        "fastIndexer.semanticConcurrency": {
          "type": "number",
          "default": 2,
          "minimum": 1,
          "description": "Maximum number of concurrent semantic provider calls used by background enrichment."
        },
        "fastIndexer.semanticTimeoutMs": {
          "type": "number",
          "default": 750,
          "minimum": 0,
          "description": "Timeout in milliseconds for each background semantic provider request. Use 0 to disable the timeout."
        }
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='configuration'; npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add package.json src\configuration.ts src\semantics\semanticTypes.ts src\test\suite\configuration.test.ts
git commit -m "feat: add semantic enrichment configuration" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add Typed Semantic Provider Bridge Wrappers

**Files:**
- Modify: `src/bridge/providerBridge.ts`
- Test: `src/test/suite/providerBridge.test.ts`

- [ ] **Step 1: Write failing provider bridge tests**

Create `src/test/suite/providerBridge.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  getDeclarations,
  getDefinitions,
  getImplementationsAt,
  getHoverSummary,
  getReferencesAt,
  getTypeDefinitions
} from '../../bridge/providerBridge';
import { patchProperty, restoreProperty } from './helpers/propertyPatch';

suite('providerBridge semantic providers', () => {
  test('converts definition, declaration, and type-definition locations into semantic targets', async () => {
    const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
    const targetUri = vscode.Uri.file('c:\\workspace\\src\\target.ts');
    const position = new vscode.Position(3, 4);
    const calls: string[] = [];
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      calls.push(command);

      if (command === 'vscode.executeDefinitionProvider') {
        return [new vscode.Location(targetUri, new vscode.Range(10, 2, 10, 12))];
      }

      if (command === 'vscode.executeDeclarationProvider') {
        return [{
          targetUri,
          targetRange: new vscode.Range(20, 0, 20, 8),
          targetSelectionRange: new vscode.Range(21, 3, 21, 9)
        }];
      }

      if (command === 'vscode.executeTypeDefinitionProvider') {
        return [new vscode.Location(targetUri, new vscode.Range(30, 5, 30, 15))];
      }

      throw new Error(`Unexpected command ${command}`);
    }) as typeof vscode.commands.executeCommand);

    try {
      assert.deepEqual(await getDefinitions(sourceUri, position), {
        ok: true,
        value: [{ uri: targetUri.toString(), line: 10, column: 2 }]
      });
      assert.deepEqual(await getDeclarations(sourceUri, position), {
        ok: true,
        value: [{ uri: targetUri.toString(), line: 21, column: 3 }]
      });
      assert.deepEqual(await getTypeDefinitions(sourceUri, position), {
        ok: true,
        value: [{ uri: targetUri.toString(), line: 30, column: 5 }]
      });
      assert.deepEqual(calls, [
        'vscode.executeDefinitionProvider',
        'vscode.executeDeclarationProvider',
        'vscode.executeTypeDefinitionProvider'
      ]);
    } finally {
      restoreProperty(executePatch);
    }
  });

  test('returns explicit failures when semantic providers throw', async () => {
    const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async () => {
      throw new Error('provider exploded');
    }) as typeof vscode.commands.executeCommand);

    try {
      assert.deepEqual(await getDefinitions(sourceUri, new vscode.Position(0, 0)), {
        ok: false,
        error: 'provider exploded'
      });
    } finally {
      restoreProperty(executePatch);
    }
  });

  test('summarizes hover markdown and plain string content', async () => {
    const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      assert.equal(command, 'vscode.executeHoverProvider');
      return [{
        contents: [
          new vscode.MarkdownString('```ts\\nclass Alpha\\n```'),
          'Creates alpha values.'
        ]
      }];
    }) as typeof vscode.commands.executeCommand);

    try {
      assert.deepEqual(await getHoverSummary(sourceUri, new vscode.Position(0, 0)), {
        ok: true,
        value: 'class Alpha Creates alpha values.'
      });
    } finally {
      restoreProperty(executePatch);
    }
  });

  test('uses explicit document URIs for background reference and implementation calls', async () => {
    const sourceUri = vscode.Uri.file('c:\\workspace\\src\\source.ts');
    const targetUri = vscode.Uri.file('c:\\workspace\\src\\target.ts');
    const position = new vscode.Position(2, 3);
    const calls: Array<{ command: string; uri: string; }> = [];
    const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri: vscode.Uri) => {
      calls.push({ command, uri: uri.toString() });

      if (command === 'vscode.executeReferenceProvider') {
        return [new vscode.Location(targetUri, new vscode.Range(4, 1, 4, 6))];
      }

      if (command === 'vscode.executeImplementationProvider') {
        return [new vscode.Location(targetUri, new vscode.Range(8, 2, 8, 7))];
      }

      throw new Error(`Unexpected command ${command}`);
    }) as typeof vscode.commands.executeCommand);

    try {
      assert.deepEqual(await getReferencesAt(sourceUri, position), [{
        uri: targetUri.toString(),
        line: 4,
        approximate: false
      }]);
      assert.deepEqual(await getImplementationsAt(sourceUri, position), [{
        uri: targetUri.toString(),
        line: 8,
        approximate: false
      }]);
      assert.deepEqual(calls, [
        { command: 'vscode.executeReferenceProvider', uri: sourceUri.toString() },
        { command: 'vscode.executeImplementationProvider', uri: sourceUri.toString() }
      ]);
    } finally {
      restoreProperty(executePatch);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='providerBridge semantic providers'; npm test
```

Expected: FAIL because the new exported functions do not exist.

- [ ] **Step 3: Add typed provider result helpers**

Modify `src/bridge/providerBridge.ts` imports and types:

```ts
import type { SemanticTarget } from '../semantics/semanticTypes';

export type ProviderCallResult<T> =
  | { ok: true; value: T; }
  | { ok: false; error: string; };
```

Add these exported functions after `getImplementations`:

```ts
export async function getDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<SemanticTarget[]>> {
  return getLocationTargets('vscode.executeDefinitionProvider', uri, position);
}

export async function getDeclarations(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<SemanticTarget[]>> {
  return getLocationTargets('vscode.executeDeclarationProvider', uri, position);
}

export async function getTypeDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<SemanticTarget[]>> {
  return getLocationTargets('vscode.executeTypeDefinitionProvider', uri, position);
}

export async function getHoverSummary(uri: vscode.Uri, position: vscode.Position): Promise<ProviderCallResult<string | undefined>> {
  try {
    const hovers = await vscode.commands.executeCommand<readonly vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      position
    );
    const summary = (hovers ?? [])
      .flatMap((hover) => hover.contents)
      .map(markedStringToText)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return { ok: true, value: summary.length > 0 ? summary : undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getReferencesAt(uri: vscode.Uri, position: vscode.Position): Promise<DiscoveryResult[]> {
  const locations = await vscode.commands.executeCommand<readonly vscode.Location[]>(
    'vscode.executeReferenceProvider',
    uri,
    position
  );

  return (locations ?? []).map(toDiscoveryResult);
}

export async function getImplementationsAt(uri: vscode.Uri, position: vscode.Position): Promise<DiscoveryResult[]> {
  const locations = await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeImplementationProvider',
    uri,
    position
  );

  return (locations ?? []).map(toDiscoveryResult);
}
```

Add these private helpers near `toDiscoveryResult`:

```ts
async function getLocationTargets(
  command: 'vscode.executeDefinitionProvider' | 'vscode.executeDeclarationProvider' | 'vscode.executeTypeDefinitionProvider',
  uri: vscode.Uri,
  position: vscode.Position
): Promise<ProviderCallResult<SemanticTarget[]>> {
  try {
    const locations = await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
      command,
      uri,
      position
    );

    return { ok: true, value: (locations ?? []).map(toSemanticTarget) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function toSemanticTarget(location: vscode.Location | vscode.LocationLink): SemanticTarget {
  if ('targetUri' in location) {
    const targetRange = location.targetSelectionRange ?? location.targetRange;
    return {
      uri: location.targetUri.toString(),
      line: targetRange.start.line,
      column: targetRange.start.character
    };
  }

  return {
    uri: location.uri.toString(),
    line: location.range.start.line,
    column: location.range.start.character
  };
}

function markedStringToText(value: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof value === 'string') {
    return value.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '').trim();
  }

  if ('value' in value) {
    return value.value.replace(/```[a-zA-Z0-9_-]*\n?/g, '').replace(/```/g, '').trim();
  }

  return `${value.language} ${value.value}`.trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='providerBridge semantic providers'; npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\bridge\providerBridge.ts src\test\suite\providerBridge.test.ts
git commit -m "feat: add semantic provider bridge wrappers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Add the Semantic Metadata Index

**Files:**
- Create: `src/semantics/semanticIndex.ts`
- Test: `src/test/suite/semanticIndex.test.ts`

- [ ] **Step 1: Write failing semantic index tests**

Create `src/test/suite/semanticIndex.test.ts`:

```ts
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
    assert.equal(createSymbolSemanticKey({
      name: 'Alpha',
      kind: 5,
      containerName: 'services',
      uri: 'file:///workspace/src/alpha.ts',
      startLine: 8,
      startColumn: 2,
      approximate: false
    }), 'Alpha:5:services:8:2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='semantic enrichment index'; npm test
```

Expected: FAIL because `SemanticIndex` does not exist.

- [ ] **Step 3: Implement semantic index**

Create `src/semantics/semanticIndex.ts`:

```ts
import type { SymbolRecord } from '../indexes/symbolIndex';
import type { SemanticMetadata } from './semanticTypes';

export type SemanticIndexEntry = {
  key: string;
  metadata: SemanticMetadata;
};

export type SemanticIndexFileEntry = {
  relativePath: string;
  entries: SemanticIndexEntry[];
};

export class SemanticIndex {
  private readonly byFile = new Map<string, Map<string, SemanticMetadata>>();

  allByFile(): SemanticIndexFileEntry[] {
    return [...this.byFile.entries()].map(([relativePath, entries]) => ({
      relativePath,
      entries: [...entries.entries()].map(([key, metadata]) => ({ key, metadata: { ...metadata } }))
    }));
  }

  clear(): void {
    this.byFile.clear();
  }

  get(relativePath: string, key: string): SemanticMetadata | undefined {
    const metadata = this.byFile.get(relativePath)?.get(key);
    return metadata ? { ...metadata } : undefined;
  }

  set(relativePath: string, key: string, metadata: SemanticMetadata): void {
    const entries = this.byFile.get(relativePath) ?? new Map<string, SemanticMetadata>();
    entries.set(key, { ...metadata });
    this.byFile.set(relativePath, entries);
  }

  replaceForFile(relativePath: string, entries: SemanticIndexEntry[]): void {
    this.byFile.set(
      relativePath,
      new Map(entries.map((entry) => [entry.key, { ...entry.metadata }]))
    );
  }
}

export function createSymbolSemanticKey(symbol: Pick<SymbolRecord, 'name' | 'kind' | 'containerName' | 'startLine' | 'startColumn'>): string {
  return [
    symbol.name,
    symbol.kind,
    symbol.containerName ?? '',
    symbol.startLine,
    symbol.startColumn
  ].join(':');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='semantic enrichment index'; npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\semantics\semanticIndex.ts src\test\suite\semanticIndex.test.ts
git commit -m "feat: add semantic metadata index" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Add the Background Semantic Enrichment Service

**Files:**
- Create: `src/semantics/semanticEnrichmentService.ts`
- Test: `src/test/suite/semanticEnrichmentService.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `src/test/suite/semanticEnrichmentService.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SemanticEnrichmentService } from '../../semantics/semanticEnrichmentService';
import { SemanticIndex } from '../../semantics/semanticIndex';
import type { ProviderCallResult } from '../../bridge/providerBridge';
import type { SemanticTarget } from '../../semantics/semanticTypes';

suite('semantic enrichment service', () => {
  test('enriches queued symbols in the background without awaiting queue work', async () => {
    const semanticIndex = new SemanticIndex();
    let definitionRequested = false;
    let resolveDefinition: ((targets: ProviderCallResult<SemanticTarget[]>) => void) | undefined;
    const definitionPromise = new Promise<ProviderCallResult<SemanticTarget[]>>((resolve) => {
      resolveDefinition = resolve;
    });
    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 0,
      now: () => 100,
      providers: {
        getDefinitions: async () => {
          definitionRequested = true;
          return definitionPromise;
        },
        getDeclarations: async () => ({ ok: true, value: [] }),
        getTypeDefinitions: async () => ({ ok: true, value: [] }),
        getImplementations: async () => [],
        getReferences: async () => [],
        getHoverSummary: async () => ({ ok: true, value: undefined })
      }
    });

    service.enqueueFile('src/alpha.ts', [{
      name: 'Alpha',
      kind: vscode.SymbolKind.Class,
      uri: vscode.Uri.file('c:\\workspace\\src\\alpha.ts').toString(),
      startLine: 2,
      startColumn: 0,
      approximate: false
    }], 1);

    assert.equal(definitionRequested, true);
    assert.equal(semanticIndex.allByFile().length, 0);

    resolveDefinition?.({ ok: true, value: [{ uri: 'file:///workspace/src/alpha.ts', line: 2, column: 0 }] });
    await service.idle();

    const metadata = semanticIndex.allByFile()[0]?.entries[0]?.metadata;
    assert.equal(metadata?.status, 'enriched');
    assert.equal(metadata?.definition?.line, 2);
  });

  test('marks stale generation work as cancelled instead of writing metadata', async () => {
    const semanticIndex = new SemanticIndex();
    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 0,
      now: () => 200,
      providers: {
        getDefinitions: async () => ({ ok: true, value: [{ uri: 'file:///workspace/src/alpha.ts', line: 2, column: 0 }] }),
        getDeclarations: async () => ({ ok: true, value: [] }),
        getTypeDefinitions: async () => ({ ok: true, value: [] }),
        getImplementations: async () => [],
        getReferences: async () => [],
        getHoverSummary: async () => ({ ok: true, value: undefined })
      }
    });

    service.cancelGeneration(1);
    service.enqueueFile('src/alpha.ts', [{
      name: 'Alpha',
      kind: vscode.SymbolKind.Class,
      uri: vscode.Uri.file('c:\\workspace\\src\\alpha.ts').toString(),
      startLine: 2,
      startColumn: 0,
      approximate: false
    }], 1);
    await service.idle();

    assert.equal(semanticIndex.allByFile().length, 0);
  });

  test('marks timeout status when a provider exceeds timeout', async () => {
    const semanticIndex = new SemanticIndex();
    const service = new SemanticEnrichmentService(semanticIndex, {
      enabled: true,
      concurrency: 1,
      timeoutMs: 1,
      now: () => 300,
      providers: {
        getDefinitions: async () => new Promise(() => undefined),
        getDeclarations: async () => ({ ok: true, value: [] }),
        getTypeDefinitions: async () => ({ ok: true, value: [] }),
        getImplementations: async () => [],
        getReferences: async () => [],
        getHoverSummary: async () => ({ ok: true, value: undefined })
      }
    });

    service.enqueueFile('src/alpha.ts', [{
      name: 'Alpha',
      kind: vscode.SymbolKind.Class,
      uri: vscode.Uri.file('c:\\workspace\\src\\alpha.ts').toString(),
      startLine: 2,
      startColumn: 0,
      approximate: false
    }], 1);
    await service.idle();

    assert.equal(semanticIndex.allByFile()[0]?.entries[0]?.metadata.status, 'timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='semantic enrichment service'; npm test
```

Expected: FAIL because `SemanticEnrichmentService` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/semantics/semanticEnrichmentService.ts`:

```ts
import * as vscode from 'vscode';
import type { DiscoveryResult } from '../commands/findUsages';
import type { SymbolRecord } from '../indexes/symbolIndex';
import type { ProviderCallResult } from '../bridge/providerBridge';
import { createSymbolSemanticKey, SemanticIndex } from './semanticIndex';
import type { SemanticMetadata, SemanticTarget } from './semanticTypes';

type SemanticProviders = {
  getDefinitions: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<SemanticTarget[]>>;
  getDeclarations: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<SemanticTarget[]>>;
  getTypeDefinitions: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<SemanticTarget[]>>;
  getImplementations: (uri: vscode.Uri, position: vscode.Position) => Promise<DiscoveryResult[]>;
  getReferences: (uri: vscode.Uri, position: vscode.Position) => Promise<DiscoveryResult[]>;
  getHoverSummary: (uri: vscode.Uri, position: vscode.Position) => Promise<ProviderCallResult<string | undefined>>;
};

type SemanticEnrichmentServiceOptions = {
  enabled: boolean;
  concurrency: number;
  timeoutMs: number;
  providers: SemanticProviders;
  now?: () => number;
  onError?: (message: string) => void;
};

type SemanticWorkItem = {
  relativePath: string;
  symbol: SymbolRecord;
  generation: number;
};

export class SemanticEnrichmentService {
  private readonly queue: SemanticWorkItem[] = [];
  private readonly cancelledGenerations = new Set<number>();
  private running = 0;
  private idleResolvers: Array<() => void> = [];
  private readonly now: () => number;

  constructor(
    private readonly semanticIndex: SemanticIndex,
    private readonly options: SemanticEnrichmentServiceOptions
  ) {
    this.now = options.now ?? Date.now;
  }

  cancelGeneration(generation: number): void {
    this.cancelledGenerations.add(generation);
  }

  clear(): void {
    this.queue.length = 0;
    this.semanticIndex.clear();
    this.resolveIdleIfNeeded();
  }

  enqueueFile(relativePath: string, symbols: SymbolRecord[], generation: number): void {
    if (!this.options.enabled) {
      return;
    }

    for (const symbol of symbols) {
      if (symbol.approximate) {
        continue;
      }

      this.queue.push({ relativePath, symbol, generation });
    }

    this.drain();
  }

  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private drain(): void {
    while (this.running < this.options.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.running += 1;
      void this.enrich(item)
        .catch((error) => {
          this.options.onError?.(`Semantic enrichment failed for ${item.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.running -= 1;
          this.drain();
          this.resolveIdleIfNeeded();
        });
    }
  }

  private async enrich(item: SemanticWorkItem): Promise<void> {
    if (this.cancelledGenerations.has(item.generation)) {
      return;
    }

    const uri = vscode.Uri.parse(item.symbol.uri);
    const position = new vscode.Position(item.symbol.startLine, item.symbol.startColumn);
    const result = await this.withTimeout(this.collectMetadata(uri, position), item);

    if (this.cancelledGenerations.has(item.generation)) {
      return;
    }

    this.semanticIndex.set(item.relativePath, createSymbolSemanticKey(item.symbol), result);
  }

  private async collectMetadata(uri: vscode.Uri, position: vscode.Position): Promise<SemanticMetadata> {
    const [definitions, declarations, typeDefinitions, implementations, references, hoverSummary] = await Promise.all([
      this.options.providers.getDefinitions(uri, position),
      this.options.providers.getDeclarations(uri, position),
      this.options.providers.getTypeDefinitions(uri, position),
      this.options.providers.getImplementations(uri, position),
      this.options.providers.getReferences(uri, position),
      this.options.providers.getHoverSummary(uri, position)
    ]);

    const failed = [definitions, declarations, typeDefinitions, hoverSummary].find((result) => !result.ok);
    if (failed && !failed.ok) {
      return {
        provider: 'vscode',
        status: 'failed',
        confidence: 0,
        enrichedAt: this.now()
      };
    }

    return {
      definition: definitions.ok ? definitions.value[0] : undefined,
      declaration: declarations.ok ? declarations.value[0] : undefined,
      typeDefinition: typeDefinitions.ok ? typeDefinitions.value[0] : undefined,
      implementationCount: implementations.length,
      referenceCount: references.length,
      hoverSummary: hoverSummary.ok ? hoverSummary.value : undefined,
      provider: 'vscode',
      status: 'enriched',
      confidence: definitions.ok && definitions.value.length > 0 ? 1 : 0.75,
      enrichedAt: this.now()
    };
  }

  private async withTimeout(metadataPromise: Promise<SemanticMetadata>, item: SemanticWorkItem): Promise<SemanticMetadata> {
    if (this.options.timeoutMs <= 0) {
      return metadataPromise;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<SemanticMetadata>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({
          provider: 'vscode',
          status: 'timeout',
          confidence: 0,
          enrichedAt: this.now()
        });
      }, this.options.timeoutMs);
    });

    const metadata = await Promise.race([metadataPromise, timeoutPromise]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (metadata.status === 'timeout') {
      this.options.onError?.(`Semantic enrichment timed out for ${item.relativePath}`);
    }

    return metadata;
  }

  private resolveIdleIfNeeded(): void {
    if (this.queue.length > 0 || this.running > 0) {
      return;
    }

    while (this.idleResolvers.length > 0) {
      this.idleResolvers.shift()?.();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='semantic enrichment service'; npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\semantics\semanticEnrichmentService.ts src\test\suite\semanticEnrichmentService.test.ts
git commit -m "feat: add semantic enrichment service" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Make Symbol Search Semantic-Aware

**Files:**
- Modify: `src/shared/commandSearch.ts`
- Modify: `src/commands/goToSymbol.ts`
- Modify: `src/commands/cycleSearchMode.ts`
- Test: `src/test/suite/commandSearch.test.ts`

- [ ] **Step 1: Write failing command-search tests**

Add imports to `src/test/suite/commandSearch.test.ts`:

```ts
import type { SemanticMetadata } from '../../semantics/semanticTypes';
```

Update the commandSearch import to include `getSemanticSymbolDetail`:

```ts
import { type CommandSearchProvider, collectAvailableProviderResults, getCommandSearchIcon, getCommandSearchProvenanceIcon, getSemanticSymbolDetail, rankCommandSearchCandidates, toDiscoverySearchCandidate, toFileSearchCandidate, toSymbolSearchCandidate, toTextSearchCandidate } from '../../shared/commandSearch';
```

Add this test after `normalizes built-in result shapes into shared command search candidates`:

```ts
  test('adds semantic metadata to symbol candidates without changing approximate provenance', () => {
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

    assert.equal(getSemanticSymbolDetail(symbolRecord.uri, semanticMetadata), 'file:///workspace/src/app/main.ts • 7 refs • 3 impls • vscode');
    assert.deepEqual(toSymbolSearchCandidate(symbolRecord, semanticMetadata), {
      source: 'symbol',
      label: 'AlphaService',
      description: 'services',
      detail: 'file:///workspace/src/app/main.ts • 7 refs • 3 impls • vscode',
      filterText: 'AlphaService services',
      uri: symbolRecord.uri,
      line: 10,
      column: 2,
      approximate: false,
      semanticConfidence: 1
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='commandSearch'; npm test
```

Expected: FAIL because `getSemanticSymbolDetail`, the extended `toSymbolSearchCandidate` signature, and `semanticConfidence` do not exist.

- [ ] **Step 3: Add semantic candidate fields**

Modify `src/shared/commandSearch.ts`:

```ts
import type { SemanticMetadata } from '../semantics/semanticTypes';
```

Update `CommandSearchCandidate`:

```ts
export type CommandSearchCandidate = {
  source: CommandSearchSource;
  label: string;
  description?: string;
  detail: string;
  filterText: string;
  uri: string;
  line?: number;
  column?: number;
  approximate: boolean;
  semanticConfidence?: number;
};
```

Replace `toSymbolSearchCandidate` with:

```ts
export function toSymbolSearchCandidate(symbol: SymbolRecord, semanticMetadata?: SemanticMetadata): CommandSearchCandidate {
  return {
    source: 'symbol',
    label: symbol.name,
    description: symbol.containerName,
    detail: getSemanticSymbolDetail(symbol.uri, semanticMetadata),
    filterText: [symbol.name, symbol.containerName].filter(Boolean).join(' '),
    uri: symbol.uri,
    line: symbol.startLine,
    column: symbol.startColumn,
    approximate: symbol.approximate,
    semanticConfidence: semanticMetadata?.confidence
  };
}

export function getSemanticSymbolDetail(uri: string, semanticMetadata?: SemanticMetadata): string {
  if (!semanticMetadata || semanticMetadata.status !== 'enriched') {
    return uri;
  }

  const parts = [uri];
  if (semanticMetadata.referenceCount !== undefined) {
    parts.push(`${semanticMetadata.referenceCount} refs`);
  }
  if (semanticMetadata.implementationCount !== undefined) {
    parts.push(`${semanticMetadata.implementationCount} impls`);
  }
  parts.push(semanticMetadata.provider);
  return parts.join(' • ');
}
```

Update `rankCommandSearchCandidates` sorting:

```ts
    .sort((left, right) =>
      right.score - left.score
      || Number(right.candidate.semanticConfidence ?? 0) - Number(left.candidate.semanticConfidence ?? 0)
      || left.candidate.label.localeCompare(right.candidate.label)
    )
```

- [ ] **Step 4: Pass semantic metadata into symbol command candidates**

Modify `src/commands/goToSymbol.ts` imports:

```ts
import { createSymbolSemanticKey, type SemanticIndex } from '../semantics/semanticIndex';
```

Update the function signature:

```ts
export async function goToSymbol(
  symbolIndex: SymbolIndex,
  behavior: SymbolCommandBehavior = DEFAULT_BEHAVIOR,
  dependencies: CommandSearchDependencies = {},
  presentation: CommandSearchPresentation = {},
  semanticIndex?: SemanticIndex
): Promise<boolean> {
```

Replace candidate construction:

```ts
  const candidates = symbolIndex.all().map((symbol) => {
    const relativePath = vscode.workspace.asRelativePath(vscode.Uri.parse(symbol.uri), true);
    return toSymbolSearchCandidate(symbol, semanticIndex?.get(relativePath, createSymbolSemanticKey(symbol)));
  });
```

Modify `src/commands/cycleSearchMode.ts` imports:

```ts
import type { SemanticIndex } from '../semantics/semanticIndex';
```

Update `createCycleSearchModeCommand` signature:

```ts
export function createCycleSearchModeCommand(
  fileIndex: FileIndex,
  textIndex: TextIndex,
  symbolIndex: SymbolIndex,
  getConfig: () => FastIndexerConfig,
  debugLog?: (message: string) => void,
  semanticIndex?: SemanticIndex
): { execute: () => Promise<void>; reset: () => void; } {
```

Update symbol-mode invocation:

```ts
      opened = await goToSymbol(symbolIndex, behavior, {}, presentation, semanticIndex);
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
$env:MOCHA_GREP='commandSearch'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\shared\commandSearch.ts src\commands\goToSymbol.ts src\commands\cycleSearchMode.ts src\test\suite\commandSearch.test.ts
git commit -m "feat: enrich symbol search candidates" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Persist Semantic Metadata

**Files:**
- Modify: `src/core/persistenceStore.ts`
- Modify: `src/extension.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write failing persistence test**

Add this test in `src/test/suite/extension.test.ts` near the existing persistence tests:

```ts
  test('restores persisted semantic metadata with indexed symbols', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-semantic-restore-'));
    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const indexedFile = vscode.Uri.file(path.join(workspaceRoot, 'src', 'app', 'main.ts'));
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    let pickedItems: Array<{ label: string; detail?: string; }> | undefined;

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
      registeredCommands.set(command, callback);
      return new vscode.Disposable(() => undefined);
    }) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async () => undefined) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => []) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const showQuickPickPatch = patchProperty(vscode.window, 'showQuickPick', (async (items: readonly vscode.QuickPickItem[]) => {
      pickedItems = items.map((item) => ({ label: item.label, detail: item.detail }));
      return undefined;
    }) as typeof vscode.window.showQuickPick);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => ({
        metadata: {
          schemaVersion: 2,
          workspaceId: encodeURIComponent(workspaceUri.toString()),
          configHash: JSON.stringify({
            include: ['**/*'],
            exclude: ['**/node_modules/**', '**/.git/**'],
            ignoreFiles: [],
            sharedIgnoreFiles: [],
            ignoreInputs: [],
            maxFileSizeKb: 512,
            semanticEnrichment: true,
            semanticConcurrency: 2,
            semanticTimeoutMs: 750
          })
        },
        fileIndex: [],
        textIndex: [],
        symbolIndex: [{
          relativePath: 'src/app/main.ts',
          symbols: [{
            name: 'MainService',
            kind: vscode.SymbolKind.Class,
            uri: indexedFile.toString(),
            startLine: 0,
            startColumn: 0,
            approximate: false
          }]
        }],
        semanticIndex: [{
          relativePath: 'src/app/main.ts',
          entries: [{
            key: 'MainService:5::0:0',
            metadata: {
              provider: 'vscode',
              status: 'enriched',
              confidence: 1,
              referenceCount: 6,
              implementationCount: 2,
              enrichedAt: 123
            }
          }]
        }]
      })) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      await Promise.resolve(registeredCommands.get('fastIndexer.goToSymbol')?.());

      assert.deepEqual(pickedItems, [{
        label: 'MainService',
        detail: `${indexedFile.toString()} • 6 refs • 2 impls • vscode`
      }]);
    } finally {
      restoreProperty(persistenceReadPatch);
      restoreProperty(showQuickPickPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='restores persisted semantic metadata'; npm test
```

Expected: FAIL because snapshots do not include `semanticIndex` and activation does not hydrate it.

- [ ] **Step 3: Extend persisted snapshot types**

Modify `src/core/persistenceStore.ts`:

```ts
import type { SemanticIndexFileEntry } from '../semantics/semanticIndex';
```

Update `PersistedWorkspaceSnapshot`:

```ts
export type PersistedWorkspaceSnapshot = {
  metadata: PersistedSnapshotMetadata;
  fileIndex: FileRecord[];
  textIndex: PersistedTextEntry[];
  symbolIndex: PersistedSymbolEntry[];
  semanticIndex?: SemanticIndexFileEntry[];
};
```

- [ ] **Step 4: Hydrate and persist semantic metadata**

Modify `src/extension.ts` imports:

```ts
import {
  getDeclarations,
  getDefinitions,
  getImplementationsAt,
  getHoverSummary,
  getReferencesAt,
  getTypeDefinitions,
  getDocumentSymbols
} from './bridge/providerBridge';
import { SemanticEnrichmentService } from './semantics/semanticEnrichmentService';
import { SemanticIndex } from './semantics/semanticIndex';
```

Replace the existing provider bridge import:

```ts
import { getDocumentSymbols } from './bridge/providerBridge';
```

with the combined import above.

Create the semantic index near the other indexes:

```ts
  const semanticIndex = new SemanticIndex();
```

Update coordinator clear indexes:

```ts
      semanticIndex.clear();
```

Update `restorePersistedSnapshot` signature and call to include `semanticIndex`:

```ts
       semanticIndex
```

Update `hydrateIndexesFromSnapshot` signature and body:

```ts
function hydrateIndexesFromSnapshot(
  snapshot: PersistedWorkspaceSnapshot,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): void {
  fileIndex.clear();
  symbolIndex.clear();
  textIndex.clear();
  semanticIndex.clear();

  snapshot.fileIndex.forEach((entry) => {
    fileIndex.upsert(entry.relativePath, entry.uri, toIndexedSnapshotKey(entry));
  });
  snapshot.textIndex.forEach((entry) => {
    textIndex.upsert(entry.relativePath, entry.uri, entry.content);
  });
  snapshot.symbolIndex.forEach((entry) => {
    symbolIndex.replaceForFile(entry.relativePath, entry.symbols);
  });
  snapshot.semanticIndex?.forEach((entry) => {
    semanticIndex.replaceForFile(entry.relativePath, entry.entries);
  });
}
```

Update `createPersistedWorkspaceSnapshot` signature and body:

```ts
function createPersistedWorkspaceSnapshot(
  workspacePersistence: WorkspacePersistence,
  persistenceConfigHash: string,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex
): PersistedWorkspaceSnapshot {
  return {
    metadata: {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      workspaceId: workspacePersistence.workspaceId,
      configHash: persistenceConfigHash
    },
    fileIndex: fileIndex.all(),
    textIndex: textIndex.allContents(),
    symbolIndex: symbolIndex.allByFile(),
    semanticIndex: semanticIndex.allByFile()
  };
}
```

Update every call to `createPersistedWorkspaceSnapshot(...)` with `semanticIndex`.

Update `goToSymbol` command call:

```ts
    await goToSymbol(symbolIndex, getConfig(), {}, {}, semanticIndex);
```

Update cycle command creation:

```ts
  const cycleSearchMode = createCycleSearchModeCommand(fileIndex, textIndex, symbolIndex, getConfig, cycleLog, semanticIndex);
```

- [ ] **Step 5: Include semantic config in persistence hash and bump schema**

In `src/extension.ts`, update:

```ts
const PERSISTENCE_SCHEMA_VERSION = 2;
```

Update `createPersistenceConfigHash`:

```ts
    maxFileSizeKb: config.maxFileSizeKb,
    semanticEnrichment: config.semanticEnrichment,
    semanticConcurrency: config.semanticConcurrency,
    semanticTimeoutMs: config.semanticTimeoutMs
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='restores persisted semantic metadata'; npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src\core\persistenceStore.ts src\extension.ts src\test\suite\extension.test.ts
git commit -m "feat: persist semantic metadata" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Wire Background Enrichment into Activation

**Files:**
- Modify: `src/extension.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write failing responsiveness test**

Add this test in `src/test/suite/extension.test.ts` near the persistence tests:

```ts
  test('semantic enrichment does not block initial snapshot persistence when providers are slow', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-semantic-responsive-'));
    const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
    await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
    await fs.writeFile(indexedFilePath, 'class MainService {}', 'utf8');

    const workspaceUri = vscode.Uri.file(workspaceRoot);
    const indexedFile = vscode.Uri.file(indexedFilePath);
    let persisted = false;
    let semanticProviderStarted = false;
    let resolvePersisted: (() => void) | undefined;
    const persistedPromise = new Promise<void>((resolve) => {
      resolvePersisted = resolve;
    });

    const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      name: 'Fast Symbol Indexer',
      append: () => undefined,
      clear: () => undefined,
      hide: () => undefined,
      replace: () => undefined,
      show: () => undefined
    })) as unknown) as typeof vscode.window.createOutputChannel);
    const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
    const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return [new vscode.DocumentSymbol(
          'MainService',
          '',
          vscode.SymbolKind.Class,
          new vscode.Range(0, 0, 0, 20),
          new vscode.Range(0, 6, 0, 17)
        )];
      }

      if (command === 'vscode.executeDefinitionProvider') {
        semanticProviderStarted = true;
        return new Promise(() => undefined);
      }

      if (
        command === 'vscode.executeDeclarationProvider'
        || command === 'vscode.executeTypeDefinitionProvider'
        || command === 'vscode.executeHoverProvider'
        || command === 'vscode.executeReferenceProvider'
        || command === 'vscode.executeImplementationProvider'
      ) {
        return [];
      }

      return undefined;
    }) as typeof vscode.commands.executeCommand);
    const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
    const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
      return typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts';
    }) as typeof vscode.workspace.asRelativePath);
    const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
      uri: workspaceUri,
      index: 0,
      name: uri.path.includes('workspace') ? 'workspace' : 'other'
    })) as typeof vscode.workspace.getWorkspaceFolder);
    const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
      uri: workspaceUri,
      index: 0,
      name: 'workspace'
    }] as typeof vscode.workspace.workspaceFolders);
    const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
      onDidCreate: () => new vscode.Disposable(() => undefined),
      onDidChange: () => new vscode.Disposable(() => undefined),
      onDidDelete: () => new vscode.Disposable(() => undefined),
      dispose: () => undefined
    })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
    const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) => {
      return new vscode.Disposable(() => undefined);
    }) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
    const persistenceReadPatch = patchProperty(
      PersistenceStore.prototype,
      'readWorkspaceSnapshot',
      (async () => undefined) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
    );
    const persistenceWritePatch = patchProperty(
      PersistenceStore.prototype,
      'writeWorkspaceSnapshot',
      (async () => {
        persisted = true;
        resolvePersisted?.();
      }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
    );

    try {
      activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

      const outcome = await Promise.race([
        persistedPromise.then(() => 'persisted'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
      ]);

      assert.equal(outcome, 'persisted');
      assert.equal(persisted, true);
      assert.equal(semanticProviderStarted, true);
    } finally {
      restoreProperty(persistenceWritePatch);
      restoreProperty(persistenceReadPatch);
      restoreProperty(configListenerPatch);
      restoreProperty(watcherPatch);
      restoreProperty(workspaceFoldersPatch);
      restoreProperty(workspaceFolderPatch);
      restoreProperty(relativePatch);
      restoreProperty(findFilesPatch);
      restoreProperty(executeCommandPatch);
      restoreProperty(registerPatch);
      restoreProperty(outputPatch);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='semantic enrichment does not block'; npm test
```

Expected: FAIL because semantic enrichment is not started.

- [ ] **Step 3: Instantiate and use the enrichment service**

In `src/extension.ts`, after `semanticIndex` creation, add:

```ts
  let semanticService = createSemanticService(semanticIndex, config, output);
```

Add this helper near the bottom of `src/extension.ts`:

```ts
function createSemanticService(
  semanticIndex: SemanticIndex,
  config: FastIndexerConfig,
  output: vscode.OutputChannel
): SemanticEnrichmentService {
  return new SemanticEnrichmentService(semanticIndex, {
    enabled: config.semanticEnrichment,
    concurrency: config.semanticConcurrency,
    timeoutMs: config.semanticTimeoutMs,
    providers: {
      getDefinitions,
      getDeclarations,
      getTypeDefinitions,
      getImplementations: getImplementationsAt,
      getReferences: getReferencesAt,
      getHoverSummary
    },
    onError: (message) => output.appendLine(message)
  });
}
```

After `symbolIndex.replaceForFile(relativePath, symbols);` inside `buildWorkspaceIndexes`, enqueue enrichment:

```ts
        semanticService.enqueueFile(relativePath, symbols, generation);
```

To make `semanticService` and `generation` available, update `buildWorkspaceIndexes` signature:

```ts
async function buildWorkspaceIndexes(
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  config: FastIndexerConfig,
  ignoreMatcher: IgnoreMatcher,
  output: vscode.OutputChannel,
  shouldContinue: () => boolean,
  semanticService: SemanticEnrichmentService,
  generation: number
): Promise<boolean> {
```

Update the call from `buildWorkspace`:

```ts
       () => getConfig().enabled && generation === buildGeneration,
       semanticService,
       generation
```

When disabling indexing, add:

```ts
          semanticService.cancelGeneration(buildGeneration);
          semanticService.clear();
```

When starting config rebuild, before `buildGeneration += 1`, add:

```ts
    semanticService.cancelGeneration(buildGeneration);
```

After `buildGeneration += 1`, recreate the service from current config:

```ts
    semanticService = createSemanticService(semanticIndex, getConfig(), output);
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='semantic enrichment does not block'; npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\extension.ts src\test\suite\extension.test.ts
git commit -m "feat: start semantic enrichment in background" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Preserve Provider-First Discovery with Semantic Metadata Present

**Files:**
- Modify: `src/test/suite/discoveryCommands.test.ts`
- Modify: `src/indexes/symbolIndex.ts`

- [ ] **Step 1: Write failing semantic fallback ordering test**

Add this test to `src/test/suite/discoveryCommands.test.ts` after `findUsages prefers provider results over approximate local matches`:

```ts
  test('findImplementations keeps provider results ahead of enriched fallback symbols', async () => {
    const symbolIndex = new SymbolIndex();
    const contractUri = vscode.Uri.file('c:\\workspace\\src\\contract.ts');
    const providerUri = vscode.Uri.file('c:\\workspace\\src\\provider-impl.ts');
    const fallbackUri = vscode.Uri.file('c:\\workspace\\src\\fallback-impl.ts');
    symbolIndex.replaceForFile('src/fallback-impl.ts', [{
      name: 'alphaImplementation',
      kind: vscode.SymbolKind.Class,
      uri: fallbackUri.toString(),
      startLine: 10,
      startColumn: 0,
      approximate: false
    }]);

    let awaitedFallback = false;
    let pickedItems: QuickPickItem[] | undefined;
    const patches = createCommandPatches({
      activeEditor: createEditor('alpha', contractUri),
      executeCommand: async (command) => {
        if (command === 'vscode.executeImplementationProvider') {
          return [new vscode.Location(providerUri, new vscode.Range(4, 0, 4, 5))];
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      asRelativePath: (resource) =>
        isUriMatch(resource, providerUri) ? 'src/provider-impl.ts' : 'src/fallback-impl.ts',
      showQuickPick: async (items) => {
        pickedItems = items.map((item) => ({
          label: item.label,
          description: item.description,
          detail: item.detail,
          iconPath: item.iconPath as vscode.ThemeIcon | undefined
        }));
        return undefined;
      }
    });

    try {
      await findImplementations(symbolIndex, {
        awaitFallbackReady: async () => {
          awaitedFallback = true;
        }
      });
    } finally {
      restorePatches(patches);
    }

    assert.equal(awaitedFallback, false);
    assert.deepEqual(pickedItems?.map((item) => item.label), ['src/provider-impl.ts:5']);
    assert.equal((pickedItems?.[0]?.iconPath as vscode.ThemeIcon | undefined)?.id, 'circle-filled');
  });
```

- [ ] **Step 2: Run discovery tests**

Run:

```powershell
$env:MOCHA_GREP='findImplementations keeps provider results'; npm test
```

Expected: PASS if previous tasks preserved provider-first behavior. If it fails, inspect `chooseImplementationResults()` and keep this implementation:

```ts
export function chooseImplementationResults(
  providerResults: DiscoveryResult[],
  fallbackResults: DiscoveryResult[]
): DiscoveryResult[] {
  return providerResults.length > 0 ? providerResults : fallbackResults;
}
```

- [ ] **Step 3: Add deterministic approximate ordering**

If fallback ordering changed while adding semantic hooks, keep `src/indexes/symbolIndex.ts` search ordering as:

```ts
  search(query: string): SymbolRecord[] {
    const needle = query.toLowerCase();
    return [...this.byFile.values()]
      .flat()
      .filter((symbol) => symbol.name.toLowerCase().includes(needle))
      .sort((a, b) =>
        Number(a.approximate) - Number(b.approximate)
        || a.name.localeCompare(b.name)
        || a.uri.localeCompare(b.uri)
      );
  }
```

- [ ] **Step 4: Run discovery tests**

Run:

```powershell
$env:MOCHA_GREP='discoveryCommands'; npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\indexes\symbolIndex.ts src\test\suite\discoveryCommands.test.ts
git commit -m "test: preserve provider-first discovery semantics" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Full Verification and Documentation Check

**Files:**
- Modify only if verification exposes a concrete issue in files touched by earlier tasks.

- [ ] **Step 1: Run typecheck and compile**

Run:

```powershell
npm run typecheck; npm run compile
```

Expected: both commands exit with code 0.

- [ ] **Step 2: Run the full test suite**

Run:

```powershell
npm test
```

Expected: full suite passes.

- [ ] **Step 3: Inspect changed files**

Run:

```powershell
git --no-pager diff --stat HEAD
git --no-pager diff --check
```

Expected: diff stat includes only semantic enrichment implementation files, tests, and package metadata; `diff --check` exits with code 0.

- [ ] **Step 4: Commit final fixes if needed**

If Step 1, Step 2, or Step 3 required fixes, commit them:

```powershell
git add package.json src\bridge\providerBridge.ts src\configuration.ts src\core\persistenceStore.ts src\extension.ts src\indexes\symbolIndex.ts src\shared\commandSearch.ts src\commands\goToSymbol.ts src\commands\cycleSearchMode.ts src\semantics src\test\suite
git commit -m "fix: stabilize semantic enrichment integration" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no files changed after verification, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: provider bridge, background enrichment, semantic metadata, configuration, persistence, provider-first behavior, approximate labels, and responsiveness regression coverage are each represented by tasks.
- Scope: direct LSP client management is excluded; all semantic work routes through VS Code provider commands.
- Type consistency: semantic metadata types flow from `semanticTypes.ts` into `SemanticIndex`, `SemanticEnrichmentService`, persistence, and command-search candidate shaping.
