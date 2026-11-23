# Layered Startup Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FastSearch usable much earlier in large workspaces by splitting startup indexing into file, text, symbol, and semantic layers, while leaving a clean seam for the in-flight Merkle invalidation worktree to supply reuse decisions later.

**Architecture:** Keep the existing `FileIndex`, `TextIndex`, `SymbolIndex`, and `SemanticIndex` as the search surfaces, but stop treating startup as an all-or-nothing build. Introduce a layer-aware build planner plus bounded phase runners so `goToFile` can come online after the file layer, `goToText` after the text layer, and `goToSymbol` after the symbol layer. Persist checkpoints after each completed layer so restart behavior improves immediately, and shape the planner around reusable-path hints so the Merkle branch can feed it without reworking command gating again.

**Tech Stack:** TypeScript, VS Code extension APIs, existing persistence snapshot model, Mocha integration tests, npm scripts.

---

## File Structure

- Create: `src/core/indexLayerState.ts` — shared layer names, readiness metadata, and helpers for capability checks.
- Create: `src/core/indexBuildPlanner.ts` — converts discovered files plus optional reuse hints into per-layer work queues.
- Create: `src/core/indexPhaseRunner.ts` — bounded worker pool for text and symbol phase jobs.
- Create: `src/test/suite/indexBuildPlanner.test.ts` — planner and layer-state unit tests.
- Create: `src/test/suite/indexPhaseRunner.test.ts` — bounded-concurrency unit tests.
- Modify: `src/shared/types.ts` — shared persisted layer metadata types.
- Modify: `src/core/persistenceStore.ts` — persist and restore layer availability metadata alongside existing snapshot data.
- Modify: `src/extension.ts` — replace full-build gating with phase-aware startup orchestration, checkpoint persistence, and bounded phase runners.
- Modify: `src/test/suite/persistenceStore.test.ts` — verify layer-aware snapshot serialization and restore behavior.
- Modify: `src/test/suite/extension.test.ts` — verify command readiness per layer, checkpoint persistence, and non-blocking symbol/text work.

## Commands

- Full verification: `npm test`
- Faster type/build verification: `npm run typecheck; npm run compile`
- Planner-focused tests: `$env:MOCHA_GREP='indexBuildPlanner|layer state'; npm test`
- Phase-runner-focused tests: `$env:MOCHA_GREP='indexPhaseRunner|bounded concurrency'; npm test`
- Startup/readiness-focused tests: `$env:MOCHA_GREP='usable before reconciliation|file layer|text layer|symbol layer'; npm test`

## Merkle Compatibility Rules

- Do **not** make the new planner depend on a concrete Merkle snapshot type from the other worktree.
- Accept optional reuse hints keyed by normalized relative path instead, so the current branch can feed "everything pending" while the Merkle branch can later feed "unchanged/reuse vs changed/rebuild" without rewriting readiness logic.
- Keep snapshot metadata additive. The layered-startup branch should add `availableLayers` metadata without assuming ownership of future `merkle` fields.

---

### Task 1: Add layer-state and build-planner primitives

**Files:**
- Create: `src/core/indexLayerState.ts`
- Create: `src/core/indexBuildPlanner.ts`
- Create: `src/test/suite/indexBuildPlanner.test.ts`
- Modify: `src/shared/types.ts`
- Test: `src/test/suite/indexBuildPlanner.test.ts`

- [ ] **Step 1: Write the failing planner tests**

Create `src/test/suite/indexBuildPlanner.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  createIndexBuildPlan,
  type IndexCandidate,
  type IndexReuseHints
} from '../../core/indexBuildPlanner';
import {
  createLayerAvailability,
  hasLayer,
  mergeLayerAvailability
} from '../../core/indexLayerState';

suite('indexBuildPlanner', () => {
  test('keeps reused files out of pending text and symbol work queues', () => {
    const candidates: IndexCandidate[] = [
      {
        uri: vscode.Uri.file('c:\\workspace\\src\\alpha.ts'),
        relativePath: 'src/alpha.ts'
      },
      {
        uri: vscode.Uri.file('c:\\workspace\\src\\beta.ts'),
        relativePath: 'src/beta.ts'
      }
    ];
    const reuseHints: IndexReuseHints = {
      file: new Set(['src/alpha.ts']),
      text: new Set(['src/alpha.ts']),
      symbol: new Set()
    };

    const plan = createIndexBuildPlan(candidates, reuseHints);

    assert.deepEqual(plan.filePhase.map((entry) => entry.relativePath), ['src/beta.ts']);
    assert.deepEqual(plan.textPhase.map((entry) => entry.relativePath), ['src/beta.ts']);
    assert.deepEqual(plan.symbolPhase.map((entry) => entry.relativePath), ['src/alpha.ts', 'src/beta.ts']);
  });

  test('merges restored layers without losing previously available capabilities', () => {
    const restored = createLayerAvailability(['file']);
    const merged = mergeLayerAvailability(restored, ['text']);

    assert.equal(hasLayer(merged, 'file'), true);
    assert.equal(hasLayer(merged, 'text'), true);
    assert.equal(hasLayer(merged, 'symbol'), false);
  });
});
```

- [ ] **Step 2: Run the planner tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='indexBuildPlanner|layer state'; npm test
```

Expected: FAIL because `src/core/indexBuildPlanner.ts` and `src/core/indexLayerState.ts` do not exist yet.

- [ ] **Step 3: Add shared layer metadata types**

Update `src/shared/types.ts`:

```ts
export type FileRecord = {
  relativePath: string;
  uri: string;
  basename: string;
  extension: string;
  // Reserved for future token-aware ranking work; current search uses basename/path scoring only.
  tokens: string[];
};

export type WorkspacePersistence = {
  workspaceId: string;
};

export type IndexLayer = 'file' | 'text' | 'symbol' | 'semantic';

export type PersistedLayerState = {
  availableLayers: IndexLayer[];
  activeLayer?: IndexLayer;
};
```

- [ ] **Step 4: Implement layer-state and planner helpers**

Create `src/core/indexLayerState.ts`:

```ts
import type { IndexLayer, PersistedLayerState } from '../shared/types';

const LAYER_ORDER: IndexLayer[] = ['file', 'text', 'symbol', 'semantic'];

export type LayerAvailability = {
  availableLayers: Set<IndexLayer>;
  activeLayer?: IndexLayer;
};

export function createLayerAvailability(availableLayers: IndexLayer[] = [], activeLayer?: IndexLayer): LayerAvailability {
  return {
    availableLayers: new Set(availableLayers),
    activeLayer
  };
}

export function hasLayer(state: LayerAvailability, layer: IndexLayer): boolean {
  return state.availableLayers.has(layer);
}

export function markLayerAvailable(state: LayerAvailability, layer: IndexLayer): LayerAvailability {
  const next = new Set(state.availableLayers);
  next.add(layer);
  return { availableLayers: next, activeLayer: undefined };
}

export function markLayerActive(state: LayerAvailability, layer: IndexLayer): LayerAvailability {
  return {
    availableLayers: new Set(state.availableLayers),
    activeLayer: layer
  };
}

export function mergeLayerAvailability(state: LayerAvailability, layers: IndexLayer[]): LayerAvailability {
  const next = new Set(state.availableLayers);
  layers.forEach((layer) => next.add(layer));
  return { availableLayers: next, activeLayer: state.activeLayer };
}

export function toPersistedLayerState(state: LayerAvailability): PersistedLayerState {
  return {
    availableLayers: LAYER_ORDER.filter((layer) => state.availableLayers.has(layer)),
    activeLayer: state.activeLayer
  };
}
```

Create `src/core/indexBuildPlanner.ts`:

```ts
import * as vscode from 'vscode';

export type IndexCandidate = {
  uri: vscode.Uri;
  relativePath: string;
};

export type IndexReuseHints = {
  file: Set<string>;
  text: Set<string>;
  symbol: Set<string>;
};

export type IndexBuildPlan = {
  filePhase: IndexCandidate[];
  textPhase: IndexCandidate[];
  symbolPhase: IndexCandidate[];
};

export function createIndexBuildPlan(
  candidates: IndexCandidate[],
  reuseHints: IndexReuseHints
): IndexBuildPlan {
  const sorted = [...candidates].sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    filePhase: sorted.filter((candidate) => !reuseHints.file.has(candidate.relativePath)),
    textPhase: sorted.filter((candidate) => !reuseHints.text.has(candidate.relativePath)),
    symbolPhase: sorted.filter((candidate) => !reuseHints.symbol.has(candidate.relativePath))
  };
}
```

- [ ] **Step 5: Run the planner tests to verify they pass**

Run:

```powershell
$env:MOCHA_GREP='indexBuildPlanner|layer state'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the planner primitives**

Run:

```powershell
git add src\shared\types.ts src\core\indexLayerState.ts src\core\indexBuildPlanner.ts src\test\suite\indexBuildPlanner.test.ts
git commit -m "feat: add layered indexing planner primitives"
```

---

### Task 2: Make file-layer readiness unblock `goToFile`

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/test/suite/extension.test.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write the failing readiness tests**

Add these tests to `src/test/suite/extension.test.ts` near the existing persisted-snapshot activation coverage:

```ts
test('go to file is usable after the file layer completes while text and symbol work continue', async () => {
  const workspaceUri = vscode.Uri.file('c:\\workspace');
  const files = [
    vscode.Uri.parse('file:///workspace/src/alpha.ts'),
    vscode.Uri.parse('file:///workspace/src/beta.ts')
  ];
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const infoMessages: string[] = [];
  let symbolRelease: (() => void) | undefined;

  const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return new vscode.Disposable(() => registeredCommands.delete(command));
  }) as typeof vscode.commands.registerCommand);
  const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
    infoMessages.push(message);
    return message;
  }) as typeof vscode.window.showInformationMessage);
  const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
  const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((value: string | vscode.Uri) =>
    typeof value === 'string' ? value : value.path.replace('/workspace/', '')
  ) as typeof vscode.workspace.asRelativePath);
  const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', (((_uri: vscode.Uri) => ({
    uri: workspaceUri,
    index: 0,
    name: 'workspace'
  })) as unknown) as typeof vscode.workspace.getWorkspaceFolder);
  const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      await new Promise<void>((resolve) => {
        symbolRelease = resolve;
      });
      return [];
    }
    return [];
  }) as typeof vscode.commands.executeCommand);

  try {
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    await waitFor(() => registeredCommands.has('fastIndexer.goToFile'), 'goToFile command registration');
    await waitFor(() => registeredCommands.has('fastIndexer.goToText'), 'goToText command registration');

    await Promise.resolve(registeredCommands.get('fastIndexer.goToFile')?.());
    await Promise.resolve(registeredCommands.get('fastIndexer.goToText')?.());

    assert.equal(infoMessages.includes('Building initial text index. Please wait a moment.'), true);
  } finally {
    symbolRelease?.();
    restoreProperty(executePatch);
    restoreProperty(workspaceFolderPatch);
    restoreProperty(relativePatch);
    restoreProperty(findFilesPatch);
    restoreProperty(infoPatch);
    restoreProperty(registerPatch);
  }
});
```

- [ ] **Step 2: Run the readiness test to verify it fails**

Run:

```powershell
$env:MOCHA_GREP='go to file is usable after the file layer completes'; npm test
```

Expected: FAIL because the current implementation still waits for the whole build before `goToFile` opens.

- [ ] **Step 3: Add layer-specific warming messages and wait helpers**

Update the top of `src/extension.ts`:

```ts
const INITIAL_FILE_LAYER_WARMING_MESSAGE = 'Building initial file index. Please wait a moment.';
const INITIAL_TEXT_LAYER_WARMING_MESSAGE = 'Building initial text index. Please wait a moment.';
const INITIAL_SYMBOL_LAYER_WARMING_MESSAGE = 'Building initial symbol index. Please wait a moment.';
```

Add these helpers near the existing build-state locals:

```ts
let layerAvailability = createLayerAvailability();
const layerWaiters = new Map<IndexLayer, Array<() => void>>();

const resolveLayerWaiters = (layer: IndexLayer): void => {
  const waiters = layerWaiters.get(layer) ?? [];
  layerWaiters.delete(layer);
  waiters.forEach((resolve) => resolve());
};

const resolveAllLayerWaiters = (): void => {
  for (const layer of layerWaiters.keys()) {
    resolveLayerWaiters(layer);
  }
};

const waitForLayer = async (layer: IndexLayer, warmingMessage: string): Promise<boolean> => {
  await waitForInitialSnapshotRestore();

  if (hasLayer(layerAvailability, layer)) {
    return getConfig().enabled;
  }

  if (initialFileIndexBuildPending) {
    void vscode.window.showInformationMessage(warmingMessage);
  }

  while (!hasLayer(layerAvailability, layer) && initialFileIndexBuildPending) {
    await new Promise<void>((resolve) => {
      const waiters = layerWaiters.get(layer) ?? [];
      waiters.push(resolve);
      layerWaiters.set(layer, waiters);
    });
  }

  return getConfig().enabled && hasLayer(layerAvailability, layer);
};
```

- [ ] **Step 4: Split startup so file indexing completes first and marks the file layer available**

Replace the current monolithic per-file loop in `buildWorkspaceIndexes(...)` with a file-first phase:

```ts
const candidates = files
  .map((file) => ({
    uri: file,
    relativePath: vscode.workspace.asRelativePath(file, true)
  }))
  .filter((candidate) => !ignoreMatcher.ignores(candidate.uri.fsPath, candidate.relativePath));

for (const candidate of candidates) {
  if (!shouldContinue()) {
    return false;
  }

  fileIndex.upsert(candidate.relativePath, candidate.uri.toString(), toIndexedFileKey(candidate.uri, candidate.relativePath));
}

layerAvailability = markLayerAvailable(layerAvailability, 'file');
resolveLayerWaiters('file');
await persistLayerCheckpoint('text');
```

Then update the command registrations:

```ts
context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToFile', async () => {
  cycleSearchMode.reset();
  if (!getConfig().enabled) {
    void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
    return;
  }

  if (!await waitForLayer('file', INITIAL_FILE_LAYER_WARMING_MESSAGE)) {
    void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
    return;
  }

  await goToFile(fileIndex, getConfig());
}));

context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToText', async () => {
  cycleSearchMode.reset();
  if (!getConfig().enabled) {
    void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
    return;
  }

  if (!await waitForLayer('text', INITIAL_TEXT_LAYER_WARMING_MESSAGE)) {
    void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
    return;
  }

  await goToText(textIndex, getConfig());
}));

context.subscriptions.push(vscode.commands.registerCommand('fastIndexer.goToSymbol', async () => {
  cycleSearchMode.reset();
  if (!getConfig().enabled) {
    void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
    return;
  }

  if (!await waitForLayer('symbol', INITIAL_SYMBOL_LAYER_WARMING_MESSAGE)) {
    void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
    return;
  }

  await goToSymbol(symbolIndex, getConfig(), {}, {}, semanticIndex);
}));
```

- [ ] **Step 5: Run the readiness coverage to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='go to file is usable after the file layer completes|usable before reconciliation'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the file-layer readiness change**

Run:

```powershell
git add src\extension.ts src\test\suite\extension.test.ts
git commit -m "feat: unblock go to file after file layer"
```

---

### Task 3: Persist and restore layer-aware checkpoints

**Files:**
- Modify: `src/core/persistenceStore.ts`
- Modify: `src/extension.ts`
- Modify: `src/test/suite/persistenceStore.test.ts`
- Modify: `src/test/suite/extension.test.ts`
- Test: `src/test/suite/persistenceStore.test.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write the failing persistence tests**

Add this test to `src/test/suite/persistenceStore.test.ts`:

```ts
test('writes and reads available layer metadata with the workspace snapshot', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-persist-'));
  const store = new PersistenceStore(tempRoot);

  const snapshot: PersistedWorkspaceSnapshot = {
    metadata: {
      schemaVersion: 2,
      workspaceId: 'workspace-id',
      configHash: 'config-hash',
      layerState: {
        availableLayers: ['file', 'text'],
        activeLayer: 'symbol'
      }
    },
    fileIndex: [],
    textIndex: [],
    symbolIndex: []
  };

  try {
    await store.writeWorkspaceSnapshot('workspace-id', snapshot);
    const restored = await store.readWorkspaceSnapshot('workspace-id');

    assert.deepEqual(restored?.metadata.layerState, {
      availableLayers: ['file', 'text'],
      activeLayer: 'symbol'
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
```

Add this test to `src/test/suite/extension.test.ts`:

```ts
test('restores a file-only snapshot and keeps symbol search blocked until the symbol layer completes', async () => {
  const workspaceUri = vscode.Uri.file('c:\\workspace');
  const indexedFile = vscode.Uri.parse('file:///workspace/src/app/main.ts');
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const infoMessages: string[] = [];

  const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return new vscode.Disposable(() => registeredCommands.delete(command));
  }) as typeof vscode.commands.registerCommand);
  const infoPatch = patchProperty(vscode.window, 'showInformationMessage', (async (message: string) => {
    infoMessages.push(message);
    return message;
  }) as typeof vscode.window.showInformationMessage);
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
          semanticTimeoutMs: 750,
          symbolProviderTimeoutMs: 3000
        }),
        layerState: {
          availableLayers: ['file'],
          activeLayer: 'text'
        }
      },
      fileIndex: [{
        relativePath: 'src/app/main.ts',
        uri: indexedFile.toString(),
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['src', 'app', 'main', 'ts']
      }],
      textIndex: [],
      symbolIndex: []
    })) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
  );

  try {
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    await waitFor(() => registeredCommands.has('fastIndexer.goToFile'), 'goToFile registration');
    await waitFor(() => registeredCommands.has('fastIndexer.goToSymbol'), 'goToSymbol registration');

    await Promise.resolve(registeredCommands.get('fastIndexer.goToFile')?.());
    await Promise.resolve(registeredCommands.get('fastIndexer.goToSymbol')?.());

    assert.equal(infoMessages.includes('Building initial symbol index. Please wait a moment.'), true);
  } finally {
    restoreProperty(persistenceReadPatch);
    restoreProperty(infoPatch);
    restoreProperty(registerPatch);
  }
});
```

- [ ] **Step 2: Run the persistence tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='available layer metadata|file-only snapshot'; npm test
```

Expected: FAIL because snapshot metadata does not currently include per-layer availability.

- [ ] **Step 3: Extend persisted snapshot metadata with layer state**

Update `src/core/persistenceStore.ts`:

```ts
import type { PersistedLayerState } from '../shared/types';

export type PersistedSnapshotMetadata = {
  schemaVersion: number;
  workspaceId: string;
  configHash: string;
  layerState?: PersistedLayerState;
};
```

Update the snapshot builder in `src/extension.ts`:

```ts
function createPersistedWorkspaceSnapshot(
  workspacePersistence: WorkspacePersistence,
  persistenceConfigHash: string,
  fileIndex: FileIndex,
  symbolIndex: SymbolIndex,
  textIndex: TextIndex,
  semanticIndex: SemanticIndex,
  layerState: PersistedLayerState
): PersistedWorkspaceSnapshot {
  return {
    metadata: {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      workspaceId: workspacePersistence.workspaceId,
      configHash: persistenceConfigHash,
      layerState
    },
    fileIndex: fileIndex.all(),
    textIndex: textIndex.allContents(),
    symbolIndex: symbolIndex.allByFile(),
    semanticIndex: semanticIndex.allByFile()
  };
}
```

- [ ] **Step 4: Persist checkpoints after each completed layer and hydrate restored layer state**

Add this helper in `src/extension.ts`:

```ts
const persistLayerCheckpoint = async (activeLayer?: IndexLayer): Promise<void> => {
  if (!getConfig().enabled) {
    return;
  }

  await persistenceStore.writeWorkspaceSnapshot(
    workspacePersistence.workspaceId,
    createPersistedWorkspaceSnapshot(
      workspacePersistence,
      activePersistenceConfigHash,
      fileIndex,
      symbolIndex,
      textIndex,
      semanticIndex,
      toPersistedLayerState(activeLayer ? markLayerActive(layerAvailability, activeLayer) : layerAvailability)
    )
  );
};
```

When restoring:

```ts
const restoredLayerState = snapshot.metadata.layerState;
layerAvailability = restoredLayerState
  ? createLayerAvailability(restoredLayerState.availableLayers, restoredLayerState.activeLayer)
  : createLayerAvailability();
```

After each phase:

```ts
layerAvailability = markLayerAvailable(layerAvailability, 'text');
resolveLayerWaiters('text');
await persistLayerCheckpoint('symbol');

layerAvailability = markLayerAvailable(layerAvailability, 'symbol');
resolveLayerWaiters('symbol');
await persistLayerCheckpoint();
```

When the build exits, release pending waiters in the same `finally` path that already clears the build gate:

```ts
.finally(() => {
  resolveAllLayerWaiters();
  initialFileIndexBuildPending = false;
  if (rebuildQueued) {
    runQueuedRebuild();
  }
});
```

- [ ] **Step 5: Run the persistence and restore coverage to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='available layer metadata|file-only snapshot|restores a persisted snapshot'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the checkpoint persistence change**

Run:

```powershell
git add src\core\persistenceStore.ts src\extension.ts src\test\suite\persistenceStore.test.ts src\test\suite\extension.test.ts
git commit -m "feat: persist layered startup checkpoints"
```

---

### Task 4: Add bounded concurrency for text and symbol phases

**Files:**
- Create: `src/core/indexPhaseRunner.ts`
- Create: `src/test/suite/indexPhaseRunner.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/test/suite/extension.test.ts`
- Test: `src/test/suite/indexPhaseRunner.test.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write the failing bounded-concurrency tests**

Create `src/test/suite/indexPhaseRunner.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import { runPhaseJobs } from '../../core/indexPhaseRunner';

suite('indexPhaseRunner', () => {
  test('runs no more than the configured number of jobs at once', async () => {
    let activeJobs = 0;
    let maxActiveJobs = 0;

    await runPhaseJobs([1, 2, 3, 4], 2, async () => {
      activeJobs += 1;
      maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeJobs -= 1;
    });

    assert.equal(maxActiveJobs, 2);
  });
});
```

Add this test to `src/test/suite/extension.test.ts`:

```ts
test('runs symbol indexing with bounded concurrency after the file layer is available', async () => {
  const files = [
    vscode.Uri.parse('file:///workspace/src/alpha.ts'),
    vscode.Uri.parse('file:///workspace/src/beta.ts'),
    vscode.Uri.parse('file:///workspace/src/gamma.ts')
  ];
  let activeSymbolCalls = 0;
  let maxActiveSymbolCalls = 0;

  const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
  const executePatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      activeSymbolCalls += 1;
      maxActiveSymbolCalls = Math.max(maxActiveSymbolCalls, activeSymbolCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeSymbolCalls -= 1;
      return [];
    }
    return [];
  }) as typeof vscode.commands.executeCommand);

  try {
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    await waitFor(() => maxActiveSymbolCalls > 0, 'symbol phase to begin');
  } finally {
    restoreProperty(executePatch);
    restoreProperty(findFilesPatch);
  }

  assert.equal(maxActiveSymbolCalls <= 4, true);
});
```

- [ ] **Step 2: Run the concurrency tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='indexPhaseRunner|bounded concurrency'; npm test
```

Expected: FAIL because the current implementation still awaits symbol and text work one file at a time.

- [ ] **Step 3: Implement a reusable bounded phase runner**

Create `src/core/indexPhaseRunner.ts`:

```ts
export async function runPhaseJobs<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workerCount = Math.max(1, concurrency);

  await Promise.all(
    Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) {
          return;
        }
        await worker(next);
      }
    })
  );
}
```

- [ ] **Step 4: Run text and symbol phases through the bounded runner**

Update `src/extension.ts` to run text and symbol work after the file phase:

```ts
const TEXT_PHASE_CONCURRENCY = 8;
const SYMBOL_PHASE_CONCURRENCY = 4;

await runPhaseJobs(plan.textPhase, TEXT_PHASE_CONCURRENCY, async (candidate) => {
  const content = await readEligibleTextContent(vscode.workspace.fs, candidate.uri, candidate.relativePath, config.maxFileSizeKb);
  if (content !== undefined) {
    textIndex.upsert(candidate.relativePath, candidate.uri.toString(), content);
  }
});
layerAvailability = markLayerAvailable(layerAvailability, 'text');
await persistLayerCheckpoint('symbol');

await runPhaseJobs(plan.symbolPhase, SYMBOL_PHASE_CONCURRENCY, async (candidate) => {
  const symbolResult = await getDocumentSymbolsForBuild(candidate.uri, config.symbolProviderTimeoutMs);
  if (!symbolResult.timedOut) {
    symbolIndex.replaceForFile(candidate.relativePath, symbolResult.symbols);
    semanticService.enqueueFile(candidate.relativePath, symbolResult.symbols, generation);
  }
});
layerAvailability = markLayerAvailable(layerAvailability, 'symbol');
await persistLayerCheckpoint();
```

Keep the existing timeout and diagnostic behavior inside each worker so the phase runner changes throughput, not semantics.

- [ ] **Step 5: Run the concurrency and startup coverage to verify it passes**

Run:

```powershell
$env:MOCHA_GREP='indexPhaseRunner|bounded concurrency|file layer|symbol layer'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the bounded phase runners**

Run:

```powershell
git add src\core\indexPhaseRunner.ts src\extension.ts src\test\suite\indexPhaseRunner.test.ts src\test\suite\extension.test.ts
git commit -m "feat: run layered indexing phases concurrently"
```

---

