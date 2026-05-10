# Large Workspace Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large workspaces usable quickly by moving provider-backed full symbol indexing out of the startup critical path, preserving partial/restored symbol functionality, and hydrating deep symbols in a budgeted background scheduler.

**Architecture:** Keep `FileIndex`, `TextIndex`, `SymbolIndex`, and `SemanticIndex` as search surfaces, with Merkle content hashes as the invalidation source of truth. Add a symbol hydration plan/scheduler that restores reusable symbols immediately, queues stale or missing symbols by priority, and processes provider-backed work under budgets after file/text readiness. Refactor text readiness so batches can become searchable before every file has completed content hashing.

**Tech Stack:** TypeScript, VS Code extension APIs, existing Merkle/persistence pipeline, Mocha integration tests, npm scripts.

---

## File Structure

- Create: `src/core/symbolHydrationPlan.ts` — pure queue planning, priority assignment, and breadth-first ordering for symbol hydration.
- Create: `src/core/symbolHydrationScheduler.ts` — provider-agnostic scheduler with cancellation, concurrency, status counts, and batch callbacks.
- Create: `src/core/indexBenchmarkRecorder.ts` — env-gated benchmark writer for startup and hydration metrics.
- Create: `src/test/suite/symbolHydrationPlan.test.ts` — unit tests for symbol queue prioritization.
- Create: `src/test/suite/symbolHydrationScheduler.test.ts` — unit tests for scheduler cancellation, stale work, and batch progress.
- Create: `src/test/suite/indexBenchmarkRecorder.test.ts` — unit tests for benchmark output shape and disabled-by-default behavior.
- Modify: `src/shared/types.ts` — add persisted symbol hydration state types.
- Modify: `src/core/persistenceStore.ts` — persist and restore partial symbol hydration metadata.
- Modify: `src/core/indexBuildPlanner.ts` — return symbol hydration planning input instead of treating every symbol as a blocking startup phase.
- Modify: `src/extension.ts` — wire scheduler startup, command gating, symbol usability, checkpoint persistence, and batch-wise text hydration.
- Modify: `src/commands/goToSymbol.ts` and shared command shaping if needed — label partial symbol results.
- Modify: `src/commands/findUsages.ts` and `src/commands/findImplementations.ts` only if fallback readiness must distinguish text-ready from symbol-complete.
- Modify: `src/test/suite/persistenceStore.test.ts` — verify partial symbol hydration metadata serialization.
- Modify: `src/test/suite/extension.test.ts` — verify startup readiness, command gating, partial symbols, and background hydration.

## Commands

- Type-check: `npm run typecheck`
- Build: `npm run compile`
- Full suite: `npm test`
- Symbol hydration focused tests: `$env:MOCHA_GREP='symbolHydration'; npm test`
- Activation/readiness focused tests: `$env:MOCHA_GREP='partial symbol|background symbol|text usable|symbol hydration'; npm test`

---

### Task 1: Add symbol hydration planning primitives

**Files:**
- Create: `src/core/symbolHydrationPlan.ts`
- Create: `src/test/suite/symbolHydrationPlan.test.ts`

- [ ] **Step 1: Write the failing priority tests**

Create `src/test/suite/symbolHydrationPlan.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  createSymbolHydrationPlan,
  type SymbolHydrationCandidate
} from '../../core/symbolHydrationPlan';

function candidate(relativePath: string): SymbolHydrationCandidate {
  return {
    uri: vscode.Uri.file(`c:\\workspace\\${relativePath.replace(/\//g, '\\')}`),
    relativePath,
    contentHash: `${relativePath}-hash`
  };
}

suite('symbolHydrationPlan', () => {
  test('prioritizes open files before changed files and background files', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('keyboards/planck/keymaps/default/keymap.c'),
        candidate('quantum/action.c'),
        candidate('docs/readme.md')
      ],
      {
        openPaths: new Set(['docs/readme.md']),
        changedPaths: new Set(['quantum/action.c']),
        hydratedPaths: new Set()
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), [
      'docs/readme.md',
      'quantum/action.c',
      'keyboards/planck/keymaps/default/keymap.c'
    ]);
    assert.deepEqual(plan.items.map((item) => item.reason), ['open', 'changed', 'breadth']);
  });

  test('does not queue paths that already have reusable hydrated symbols', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('quantum/action.c'),
        candidate('quantum/keycode.c')
      ],
      {
        openPaths: new Set(),
        changedPaths: new Set(),
        hydratedPaths: new Set(['quantum/action.c'])
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), ['quantum/keycode.c']);
  });

  test('uses breadth-first ordering for background coverage', () => {
    const plan = createSymbolHydrationPlan(
      [
        candidate('keyboards/vendor/board/keymaps/default/keymap.c'),
        candidate('quantum/action.c'),
        candidate('drivers/gpio.c')
      ],
      {
        openPaths: new Set(),
        changedPaths: new Set(),
        hydratedPaths: new Set()
      }
    );

    assert.deepEqual(plan.items.map((item) => item.relativePath), [
      'drivers/gpio.c',
      'quantum/action.c',
      'keyboards/vendor/board/keymaps/default/keymap.c'
    ]);
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm the module is missing**

Run:

```powershell
$env:MOCHA_GREP='symbolHydrationPlan'; npm test
```

Expected: FAIL with a module-not-found error for `../../core/symbolHydrationPlan`.

- [ ] **Step 3: Implement the planner module**

Create `src/core/symbolHydrationPlan.ts`:

```ts
import * as vscode from 'vscode';

export type SymbolHydrationReason = 'open' | 'changed' | 'breadth';

export type SymbolHydrationCandidate = {
  uri: vscode.Uri;
  relativePath: string;
  contentHash: string;
};

export type SymbolHydrationPlanOptions = {
  openPaths: Set<string>;
  changedPaths: Set<string>;
  hydratedPaths: Set<string>;
};

export type SymbolHydrationPlanItem = SymbolHydrationCandidate & {
  reason: SymbolHydrationReason;
  priority: number;
};

export type SymbolHydrationPlan = {
  items: SymbolHydrationPlanItem[];
};

function depth(relativePath: string): number {
  return relativePath.split('/').length;
}

function reasonFor(candidate: SymbolHydrationCandidate, options: SymbolHydrationPlanOptions): SymbolHydrationReason {
  if (options.openPaths.has(candidate.relativePath)) {
    return 'open';
  }
  if (options.changedPaths.has(candidate.relativePath)) {
    return 'changed';
  }
  return 'breadth';
}

function priorityFor(reason: SymbolHydrationReason): number {
  return reason === 'open'
    ? 0
    : reason === 'changed'
      ? 1
      : 2;
}

export function createSymbolHydrationPlan(
  candidates: SymbolHydrationCandidate[],
  options: SymbolHydrationPlanOptions
): SymbolHydrationPlan {
  const items = candidates
    .filter((candidate) => !options.hydratedPaths.has(candidate.relativePath))
    .map((candidate): SymbolHydrationPlanItem => {
      const reason = reasonFor(candidate, options);
      return {
        ...candidate,
        reason,
        priority: priorityFor(reason)
      };
    })
    .sort((left, right) =>
      left.priority - right.priority ||
      depth(left.relativePath) - depth(right.relativePath) ||
      left.relativePath.localeCompare(right.relativePath)
    );

  return { items };
}
```

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run:

```powershell
$env:MOCHA_GREP='symbolHydrationPlan'; npm test
```

Expected: PASS for all `symbolHydrationPlan` tests.

- [ ] **Step 5: Commit the planner primitive**

Run:

```powershell
git add src\core\symbolHydrationPlan.ts src\test\suite\symbolHydrationPlan.test.ts
git commit -m "feat: add symbol hydration planning primitive" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add provider-agnostic symbol hydration scheduler

**Files:**
- Create: `src/core/symbolHydrationScheduler.ts`
- Create: `src/test/suite/symbolHydrationScheduler.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Create `src/test/suite/symbolHydrationScheduler.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  SymbolHydrationScheduler,
  type SymbolHydrationWorkerResult
} from '../../core/symbolHydrationScheduler';
import type { SymbolHydrationPlanItem } from '../../core/symbolHydrationPlan';

function item(relativePath: string, contentHash = `${relativePath}-hash`): SymbolHydrationPlanItem {
  return {
    uri: vscode.Uri.file(`c:\\workspace\\${relativePath.replace(/\//g, '\\')}`),
    relativePath,
    contentHash,
    reason: 'breadth',
    priority: 2
  };
}

suite('symbolHydrationScheduler', () => {
  test('processes queued items and reports status counts', async () => {
    const processed: string[] = [];
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 1,
      batchSize: 2,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (entry): Promise<SymbolHydrationWorkerResult> => {
        processed.push(entry.relativePath);
        return { status: 'hydrated' };
      }
    });

    scheduler.enqueue([item('a.c'), item('b.c'), item('c.c')], 1);
    await scheduler.drain();

    assert.deepEqual(processed, ['a.c', 'b.c', 'c.c']);
    assert.deepEqual(scheduler.getStatusCounts(), {
      queued: 0,
      running: 0,
      hydrated: 3,
      failed: 0,
      timedOut: 0,
      skipped: 0
    });
  });

  test('skips stale generation work', async () => {
    const processed: string[] = [];
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 1,
      batchSize: 10,
      getGeneration: () => 2,
      isCurrent: (_entry, generation) => generation === 2,
      worker: async (entry): Promise<SymbolHydrationWorkerResult> => {
        processed.push(entry.relativePath);
        return { status: 'hydrated' };
      }
    });

    scheduler.enqueue([item('stale.c')], 1);
    await scheduler.drain();

    assert.deepEqual(processed, []);
    assert.equal(scheduler.getStatusCounts().skipped, 1);
  });

  test('calls onBatchComplete after each batch', async () => {
    const batches: number[] = [];
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 1,
      batchSize: 2,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (): Promise<SymbolHydrationWorkerResult> => ({ status: 'hydrated' }),
      onBatchComplete: (counts) => {
        batches.push(counts.hydrated);
      }
    });

    scheduler.enqueue([item('a.c'), item('b.c'), item('c.c')], 1);
    await scheduler.drain();

    assert.deepEqual(batches, [2, 3]);
  });
});
```

- [ ] **Step 2: Run scheduler tests and confirm the module is missing**

Run:

```powershell
$env:MOCHA_GREP='symbolHydrationScheduler'; npm test
```

Expected: FAIL with a module-not-found error for `../../core/symbolHydrationScheduler`.

- [ ] **Step 3: Implement the scheduler**

Create `src/core/symbolHydrationScheduler.ts`:

```ts
import type { SymbolHydrationPlanItem } from './symbolHydrationPlan';

export type SymbolHydrationWorkerStatus = 'hydrated' | 'failed' | 'timedOut' | 'skipped';

export type SymbolHydrationWorkerResult = {
  status: SymbolHydrationWorkerStatus;
};

export type SymbolHydrationStatusCounts = {
  queued: number;
  running: number;
  hydrated: number;
  failed: number;
  timedOut: number;
  skipped: number;
};

type QueuedSymbolHydrationItem = {
  item: SymbolHydrationPlanItem;
  generation: number;
};

export type SymbolHydrationSchedulerOptions = {
  concurrency: number;
  batchSize: number;
  getGeneration: () => number;
  isCurrent: (item: SymbolHydrationPlanItem, generation: number) => boolean;
  worker: (item: SymbolHydrationPlanItem) => Promise<SymbolHydrationWorkerResult>;
  onBatchComplete?: (counts: SymbolHydrationStatusCounts) => Promise<void> | void;
};

export class SymbolHydrationScheduler {
  private readonly queue: QueuedSymbolHydrationItem[] = [];
  private readonly counts: SymbolHydrationStatusCounts = {
    queued: 0,
    running: 0,
    hydrated: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0
  };
  private cancelled = false;

  constructor(private readonly options: SymbolHydrationSchedulerOptions) {}

  enqueue(items: SymbolHydrationPlanItem[], generation = this.options.getGeneration()): void {
    if (items.length === 0) {
      return;
    }

    this.queue.push(...items.map((item) => ({ item, generation })));
    this.counts.queued = this.queue.length;
  }

  cancel(): void {
    this.cancelled = true;
    this.counts.skipped += this.queue.length;
    this.queue.length = 0;
    this.counts.queued = 0;
  }

  getStatusCounts(): SymbolHydrationStatusCounts {
    return { ...this.counts, queued: this.queue.length };
  }

  async drain(): Promise<void> {
    const workerCount = Math.max(1, Math.min(this.options.concurrency, this.queue.length || 1));
    await Promise.all(Array.from({ length: workerCount }, () => this.runWorker()));
  }

  private async runWorker(): Promise<void> {
    let completedSinceCheckpoint = 0;

    while (!this.cancelled) {
      const next = this.queue.shift();
      this.counts.queued = this.queue.length;
      if (!next) {
        return;
      }

      if (!this.options.isCurrent(next.item, next.generation)) {
        this.counts.skipped += 1;
        completedSinceCheckpoint += 1;
        await this.maybeCheckpoint(completedSinceCheckpoint);
        completedSinceCheckpoint = completedSinceCheckpoint >= this.options.batchSize ? 0 : completedSinceCheckpoint;
        continue;
      }

      this.counts.running += 1;
      const result = await this.options.worker(next.item);
      this.counts.running -= 1;
      this.counts[result.status] += 1;
      completedSinceCheckpoint += 1;
      await this.maybeCheckpoint(completedSinceCheckpoint);
      completedSinceCheckpoint = completedSinceCheckpoint >= this.options.batchSize ? 0 : completedSinceCheckpoint;
    }
  }

  private async maybeCheckpoint(completedSinceCheckpoint: number): Promise<void> {
    if (completedSinceCheckpoint < this.options.batchSize) {
      return;
    }

    await this.options.onBatchComplete?.(this.getStatusCounts());
  }
}
```

- [ ] **Step 4: Run scheduler tests and confirm they pass**

Run:

```powershell
$env:MOCHA_GREP='symbolHydrationScheduler'; npm test
```

Expected: PASS for all `symbolHydrationScheduler` tests.

- [ ] **Step 5: Commit the scheduler**

Run:

```powershell
git add src\core\symbolHydrationScheduler.ts src\test\suite\symbolHydrationScheduler.test.ts
git commit -m "feat: add symbol hydration scheduler" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Persist partial symbol hydration state

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/core/persistenceStore.ts`
- Modify: `src/test/suite/persistenceStore.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Add this test to `src/test/suite/persistenceStore.test.ts` near the other snapshot metadata tests:

```ts
test('persists partial symbol hydration metadata', async () => {
  const snapshot = createTestWorkspaceSnapshot({
    metadata: {
      schemaVersion: 2,
      workspaceId: 'workspace-a',
      configHash: 'config-a',
      layerState: {
        availableLayers: ['file', 'text', 'symbol']
      },
      symbolHydration: {
        status: 'running',
        completedPaths: ['src/hydrated.ts'],
        failedPaths: ['src/failed.ts'],
        timedOutPaths: ['src/slow.ts']
      }
    }
  });

  await store.writeWorkspaceSnapshot('workspace-a', snapshot);
  const restored = await store.readWorkspaceSnapshot('workspace-a');

  assert.deepEqual(restored?.metadata.symbolHydration, {
    status: 'running',
    completedPaths: ['src/hydrated.ts'],
    failedPaths: ['src/failed.ts'],
    timedOutPaths: ['src/slow.ts']
  });
});
```

- [ ] **Step 2: Run persistence tests and confirm the type fails**

Run:

```powershell
$env:MOCHA_GREP='symbol hydration metadata|PersistenceStore'; npm test
```

Expected: FAIL because `metadata.symbolHydration` is not part of the persisted snapshot type.

- [ ] **Step 3: Add shared persisted symbol hydration types**

Update `src/shared/types.ts`:

```ts
export type PersistedSymbolHydrationStatus = 'idle' | 'running' | 'complete' | 'paused';

export type PersistedSymbolHydrationState = {
  status: PersistedSymbolHydrationStatus;
  completedPaths: string[];
  failedPaths: string[];
  timedOutPaths: string[];
};
```

- [ ] **Step 4: Extend persisted snapshot metadata**

Update the persisted snapshot metadata type in `src/core/persistenceStore.ts` so metadata includes:

```ts
import type { PersistedLayerState, PersistedSymbolHydrationState } from '../shared/types';

export type PersistedWorkspaceSnapshotMetadata = {
  schemaVersion: number;
  workspaceId: string;
  configHash: string;
  layerState?: PersistedLayerState;
  symbolHydration?: PersistedSymbolHydrationState;
};
```

If the metadata type is inline instead of named, add `symbolHydration?: PersistedSymbolHydrationState` to that inline metadata shape and keep existing fields unchanged.

- [ ] **Step 5: Run persistence tests and confirm they pass**

Run:

```powershell
$env:MOCHA_GREP='symbol hydration metadata|PersistenceStore'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit persistence metadata**

Run:

```powershell
git add src\shared\types.ts src\core\persistenceStore.ts src\test\suite\persistenceStore.test.ts
git commit -m "feat: persist symbol hydration metadata" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Decouple initial build completion from full symbol hydration

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/test/suite/extension.test.ts`
- Modify: `src/core/indexBuildPlanner.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write failing activation test for non-blocking symbol hydration**

Add an activation test in `src/test/suite/extension.test.ts` next to the existing test named `go to file is usable after the file layer completes while text and symbol work continue`. Reuse that test's local patch setup for workspace folders, `findFiles`, config, fake quick picks, persistence stubs, and command registration. Change the provider patch so the document-symbol provider is slow and count how many files it has reached:

```ts
test('marks initial build complete after text readiness while symbol hydration continues in background', async () => {
  const symbolRequests: string[] = [];
  patchProperty(vscode.commands, 'executeCommand', async (command: string, uri?: vscode.Uri) => {
    if (command === 'vscode.executeDocumentSymbolProvider' && uri) {
      symbolRequests.push(vscode.workspace.asRelativePath(uri, true));
      await new Promise((resolve) => setTimeout(resolve, 25));
      return [];
    }
    return undefined;
  });

  activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

  await waitFor(() => registeredCommands.has('fastIndexer.goToText'), 'goToText command registration');
  await waitFor(() => infoMessages.length === 0, 'startup without blocking information message');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const goToTextCommand = registeredCommands.get('fastIndexer.goToText');
  assert.ok(goToTextCommand);
  await goToTextCommand();
  assert.ok(symbolRequests.length < 3);
});
```

- [ ] **Step 2: Run the activation test and confirm it fails**

Run:

```powershell
$env:MOCHA_GREP='symbol hydration continues in background'; npm test
```

Expected: FAIL because current activation waits for the full `symbolPhase`.

- [ ] **Step 3: Wire the scheduler into `src/extension.ts`**

In `src/extension.ts`, import the new modules:

```ts
import { createSymbolHydrationPlan } from './core/symbolHydrationPlan';
import { SymbolHydrationScheduler } from './core/symbolHydrationScheduler';
```

Create one scheduler inside `activate(...)` after index creation:

```ts
const symbolHydrationScheduler = new SymbolHydrationScheduler({
  concurrency: SYMBOL_PHASE_CONCURRENCY,
  batchSize: 100,
  getGeneration: () => buildGeneration,
  isCurrent: (_item, generation) => generation === buildGeneration,
  worker: async (item) => {
    const result = await refreshWorkspaceSymbolsOnly(
      item.uri,
      item.relativePath,
      getConfig(),
      buildGeneration,
      output,
      () => getConfig().enabled && generation === buildGeneration,
      semanticService,
      symbolIndex,
      semanticIndex
    );

    if (result.aborted) {
      return { status: 'skipped' };
    }
    if (result.symbolTimedOut) {
      return { status: 'timedOut' };
    }
    return { status: 'hydrated' };
  },
  onBatchComplete: async () => {
    if (workspaceMerkleState) {
      await persistLayerCheckpoint(workspaceMerkleState, 'symbol');
    }
  }
});
context.subscriptions.push({ dispose: () => symbolHydrationScheduler.cancel() });
```

Use the actual in-scope generation variable name inside the worker. The important requirement is that the worker checks the generation captured for each queue item, not a stale global state alone.

- [ ] **Step 4: Replace the blocking symbol phase with scheduler enqueue**

In `buildWorkspaceIndexesLayered(...)`, replace the `await runPhaseJobs(plan.symbolPhase, SYMBOL_PHASE_CONCURRENCY, ...)` block with:

```ts
const symbolPlan = createSymbolHydrationPlan(
  plan.symbolPhase.map((candidate) => {
    const leaf = currentMerkle.leavesByPath.get(normalizeWorkspaceMerklePath(candidate.relativePath));
    return {
      uri: candidate.uri,
      relativePath: candidate.relativePath,
      contentHash: leaf?.contentHash ?? ''
    };
  }).filter((candidate) => candidate.contentHash.length > 0),
  {
    openPaths: new Set(vscode.window.visibleTextEditors.map((editor) => normalizeWorkspaceMerklePath(vscode.workspace.asRelativePath(editor.document.uri, true)))),
    changedPaths: new Set(plan.symbolPhase.map((candidate) => candidate.relativePath)),
    hydratedPaths: reuseHints.symbol
  }
);

enqueueSymbolHydration(symbolPlan.items, generation);
markLayerReady('symbol');
return {
  completed: true,
  canPersistSnapshot: true,
  merkle: currentMerkle.tree
};
```

Thread an `enqueueSymbolHydration` callback into `buildWorkspaceIndexesLayered(...)` rather than importing the scheduler into the helper directly. This keeps the helper testable.

- [ ] **Step 5: Start background draining outside the critical path**

In the callback passed from `activate(...)`:

```ts
const enqueueSymbolHydration = (items: SymbolHydrationPlanItem[], generation: number): void => {
  symbolHydrationScheduler.enqueue(items, generation);
  void symbolHydrationScheduler.drain();
};
```

Use this callback as the new argument to `buildWorkspaceIndexesLayered(...)`.

- [ ] **Step 6: Run the focused activation test**

Run:

```powershell
$env:MOCHA_GREP='symbol hydration continues in background'; npm test
```

Expected: PASS.

- [ ] **Step 7: Run typecheck and compile**

Run:

```powershell
npm run typecheck; npm run compile
```

Expected: both commands exit with code 0.

- [ ] **Step 8: Commit non-blocking symbol hydration**

Run:

```powershell
git add src\extension.ts src\core\indexBuildPlanner.ts src\test\suite\extension.test.ts
git commit -m "feat: defer full symbol hydration after startup" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Update command gating and partial result messaging

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/commands/goToSymbol.ts`
- Modify: `src/shared/commandSearch.ts` if quick-pick details are shaped there
- Modify: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write failing command tests**

Add this test in `src/test/suite/goToSymbol.test.ts`:

```ts
test('goToSymbol does not wait for complete background symbol hydration', async () => {
  const index = new SymbolIndex();
  index.replaceForFile('src/ready.ts', [{
    name: 'readySymbol',
    kind: vscode.SymbolKind.Function,
    uri: vscode.Uri.file('c:\\workspace\\src\\ready.ts').toString(),
    startLine: 0,
    startColumn: 0,
    approximate: false
  }]);

  const quickPick = new FakeQuickPick<vscode.QuickPickItem & {
    symbol: { uri: string; startLine: number; startColumn: number; name: string; };
  }>();
  const pickerPatch = patchProperty(vscode.window, 'createQuickPick', ((() => quickPick) as unknown) as typeof vscode.window.createQuickPick);
  const openPatch = patchProperty(vscode.workspace, 'openTextDocument', ((async (uri: vscode.Uri) => ({ uri } as vscode.TextDocument)) as unknown) as typeof vscode.workspace.openTextDocument);
  const showPatch = patchProperty(vscode.window, 'showTextDocument', (async () => ({
    selection: undefined,
    revealRange: () => undefined
  }) as unknown as vscode.TextEditor) as typeof vscode.window.showTextDocument);

  try {
    await goToSymbol(index, { completionStyleResults: true, fuzzySearch: true }, {}, {
      partialResultsMessage: 'Partial symbol index; background hydration is still running.'
    });

    assert.equal(quickPick.showed, true);
    assert.equal(quickPick.items[0]?.label, 'readySymbol');
    assert.match(quickPick.items[0]?.detail ?? '', /Partial symbol index/);
  } finally {
    restoreProperty(pickerPatch);
    restoreProperty(openPatch);
    restoreProperty(showPatch);
  }
});
```

- [ ] **Step 2: Run command test and confirm it fails**

Run:

```powershell
$env:MOCHA_GREP='goToSymbol does not wait'; npm test
```

Expected: FAIL because current command gating and result shaping do not expose partial symbol state.

- [ ] **Step 3: Add a symbol hydration state accessor in `activate(...)`**

Inside `activate(...)`, expose a local helper:

```ts
const isSymbolHydrationComplete = (): boolean => symbolHydrationScheduler.getStatusCounts().queued === 0
  && symbolHydrationScheduler.getStatusCounts().running === 0;
```

Pass a flag into `goToSymbol(...)`:

```ts
await goToSymbol(symbolIndex, getConfig(), {}, {
  partialResultsMessage: isSymbolHydrationComplete() ? undefined : 'Partial symbol index; background hydration is still running.'
}, semanticIndex);
```

If `goToSymbol(...)` does not currently accept this shape, add a typed options parameter instead of using an untyped object.

- [ ] **Step 4: Update `goToSymbol` result shaping**

In `src/commands/goToSymbol.ts`, add:

```ts
export type GoToSymbolRuntimeOptions = {
  partialResultsMessage?: string;
};
```

When mapping symbol candidates into quick-pick items, append the partial message to `detail`:

```ts
const detail = runtimeOptions.partialResultsMessage
  ? candidate.detail
    ? `${candidate.detail} · ${runtimeOptions.partialResultsMessage}`
    : runtimeOptions.partialResultsMessage
  : candidate.detail;
```

Keep existing approximate labels unchanged.

- [ ] **Step 5: Update fallback readiness**

In `src/extension.ts`, replace fallback readiness that waits for full current build when only local text/symbol fallback is needed:

```ts
awaitFallbackReady: allowFallback
  ? async () => {
      await waitForInitialSnapshotRestore();
      if (!await waitForLayer('text')) {
        void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
        return false;
      }
      return true;
    }
  : undefined
```

For implementation fallback that requires symbols, wait for `symbol` usability, not full current build:

```ts
awaitFallbackReady: allowSymbolFallback
  ? async () => {
      await waitForInitialSnapshotRestore();
      if (!await waitForLayer('symbol')) {
        void vscode.window.showInformationMessage(INDEXING_DISABLED_MESSAGE);
        return false;
      }
      return true;
    }
  : undefined
```

- [ ] **Step 6: Run focused command tests**

Run:

```powershell
$env:MOCHA_GREP='goToSymbol does not wait|fallback'; npm test
```

Expected: PASS.

- [ ] **Step 7: Commit command gating changes**

Run:

```powershell
git add src\extension.ts src\commands\goToSymbol.ts src\shared\commandSearch.ts src\test\suite\extension.test.ts
git commit -m "feat: allow partial symbol search during hydration" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Only include `src\shared\commandSearch.ts` if it was modified.

---

### Task 6: Add batch-wise Merkle and text readiness

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write failing text-readiness test**

Add an activation test:

```ts
test('makes text search usable after the first content batch completes', async () => {
  const files = Array.from({ length: 150 }, (_value, index) => vscode.Uri.parse(`file:///workspace/src/file${index}.ts`));
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => files) as typeof vscode.workspace.findFiles);
  const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
    registeredCommands.set(command, callback);
    return new vscode.Disposable(() => registeredCommands.delete(command));
  }) as typeof vscode.commands.registerCommand);

  try {
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    await waitFor(() => registeredCommands.has('fastIndexer.goToText'), 'goToText command registration');
    const command = registeredCommands.get('fastIndexer.goToText');
    assert.ok(command);
    await command();
  } finally {
    restoreProperty(findFilesPatch);
    restoreProperty(registerPatch);
  }
});
```

- [ ] **Step 2: Run test and confirm current behavior waits for all files**

Run:

```powershell
$env:MOCHA_GREP='first content batch'; npm test
```

Expected: FAIL because `text` readiness is marked only after all text phase work completes.

- [ ] **Step 3: Add a batch constant**

In `src/extension.ts`, near existing phase constants:

```ts
const TEXT_HYDRATION_BATCH_SIZE = 100;
```

- [ ] **Step 4: Mark text available after first successful batch**

In the layered text phase loop, track the first batch:

```ts
let textLayerMarkedReady = hasLayerFromRestoredSnapshot;
let textBatchProcessed = 0;
```

Inside each text worker after `textIndex.upsert(...)` or `removeForFile(...)`:

```ts
textBatchProcessed += 1;
if (!textLayerMarkedReady && textBatchProcessed >= TEXT_HYDRATION_BATCH_SIZE) {
  textLayerMarkedReady = true;
  markLayerReady('text');
  await persistCheckpoint(currentMerkle.tree, 'text');
}
```

After the phase completes, keep the existing final readiness behavior:

```ts
if (!textLayerMarkedReady) {
  markLayerReady('text');
}
await persistCheckpoint(currentMerkle.tree, 'symbol');
```

Do not persist an incomplete final Merkle tree as complete. The early checkpoint may mark text active/available, but full Merkle completion still belongs to the final checkpoint.

- [ ] **Step 5: Run focused text readiness test**

Run:

```powershell
$env:MOCHA_GREP='first content batch'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit batch text readiness**

Run:

```powershell
git add src\extension.ts src\test\suite\extension.test.ts
git commit -m "feat: expose text search after initial hydration batch" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Add reusable benchmark recording

**Files:**
- Create: `src/core/indexBenchmarkRecorder.ts`
- Create: `src/test/suite/indexBenchmarkRecorder.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Write failing benchmark recorder tests**

Create `src/test/suite/indexBenchmarkRecorder.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIndexBenchmarkRecorder } from '../../core/indexBenchmarkRecorder';

suite('indexBenchmarkRecorder', () => {
  test('does nothing when no output path is configured', async () => {
    const recorder = createIndexBenchmarkRecorder(undefined);
    recorder.record({ event: 'fileReady', elapsedMs: 10 });
    await recorder.flush();
    assert.equal(recorder.enabled, false);
  });

  test('writes benchmark events as JSON', async () => {
    const outputPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'fastsearch-benchmark-')), 'metrics.json');
    const recorder = createIndexBenchmarkRecorder(outputPath);

    recorder.record({ event: 'fileReady', elapsedMs: 10 });
    recorder.record({ event: 'textReady', elapsedMs: 20 });
    await recorder.flush();

    const json = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.deepEqual(json.events, [
      { event: 'fileReady', elapsedMs: 10 },
      { event: 'textReady', elapsedMs: 20 }
    ]);
  });
});
```

- [ ] **Step 2: Run benchmark tests and confirm module is missing**

Run:

```powershell
$env:MOCHA_GREP='indexBenchmarkRecorder'; npm test
```

Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Implement benchmark recorder**

Create `src/core/indexBenchmarkRecorder.ts`:

```ts
import * as fs from 'node:fs/promises';

export type IndexBenchmarkEvent = {
  event: 'fileReady' | 'textReady' | 'symbolUsable' | 'symbolComplete' | 'symbolBatch';
  elapsedMs: number;
  count?: number;
};

export type IndexBenchmarkRecorder = {
  enabled: boolean;
  record: (event: IndexBenchmarkEvent) => void;
  flush: () => Promise<void>;
};

export function createIndexBenchmarkRecorder(outputPath: string | undefined): IndexBenchmarkRecorder {
  const events: IndexBenchmarkEvent[] = [];

  return {
    enabled: outputPath !== undefined && outputPath.length > 0,
    record: (event) => {
      if (outputPath) {
        events.push(event);
      }
    },
    flush: async () => {
      if (!outputPath) {
        return;
      }
      await fs.writeFile(outputPath, JSON.stringify({ events }, null, 2), 'utf8');
    }
  };
}
```

- [ ] **Step 4: Wire benchmark events in `src/extension.ts`**

At activation start:

```ts
const benchmarkStartedAt = Date.now();
const benchmarkRecorder = createIndexBenchmarkRecorder(process.env.FASTSEARCH_BENCHMARK_PATH);
const elapsedMs = () => Date.now() - benchmarkStartedAt;
```

When layers become usable:

```ts
benchmarkRecorder.record({ event: `${layer}Ready` as 'fileReady' | 'textReady' | 'symbolUsable', elapsedMs: elapsedMs() });
void benchmarkRecorder.flush();
```

When scheduler batches complete:

```ts
benchmarkRecorder.record({
  event: 'symbolBatch',
  elapsedMs: elapsedMs(),
  count: counts.hydrated
});
void benchmarkRecorder.flush();
```

When symbol hydration completes:

```ts
benchmarkRecorder.record({ event: 'symbolComplete', elapsedMs: elapsedMs() });
void benchmarkRecorder.flush();
```

- [ ] **Step 5: Run benchmark tests and compile**

Run:

```powershell
$env:MOCHA_GREP='indexBenchmarkRecorder'; npm test
npm run typecheck; npm run compile
```

Expected: tests pass, typecheck passes, compile exits with code 0.

- [ ] **Step 6: Commit benchmark recorder**

Run:

```powershell
git add src\core\indexBenchmarkRecorder.ts src\test\suite\indexBenchmarkRecorder.test.ts src\extension.ts
git commit -m "feat: add reusable indexing benchmark recorder" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Full verification and QMK benchmark

**Files:**
- Modify only files needed to fix issues discovered by verification.

- [ ] **Step 1: Run full type/build/test verification**

Run:

```powershell
npm run typecheck; npm run compile; npm test
```

Expected: all commands exit with code 0.

- [ ] **Step 2: Run QMK benchmark with the reusable recorder**

Run:

```powershell
$env:FASTSEARCH_BENCHMARK_PATH='C:\Users\mahaffey\.copilot\session-state\fbe05799-ca1a-4090-a89f-0a65b1727345\files\qmk-large-workspace-hydration.json'
code.cmd --new-window --extensionDevelopmentPath='C:\Users\mahaffey\fastsearch' 'C:\Users\mahaffey\qmk\qmk_firmware'
```

Expected benchmark shape:

```json
{
  "events": [
    { "event": "fileReady", "elapsedMs": 10000 },
    { "event": "textReady", "elapsedMs": 30000 },
    { "event": "symbolUsable", "elapsedMs": 35000 },
    { "event": "symbolBatch", "elapsedMs": 45000, "count": 100 }
  ]
}
```

The exact times will vary. The required behavioral improvement is that `symbolUsable` is reported long before full provider-backed workspace hydration completes.

- [ ] **Step 3: Stop only the benchmark VS Code processes**

Run:

```powershell
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like '*extensionDevelopmentPath=C:\Users\mahaffey\fastsearch*' }
foreach ($proc in $procs) { Stop-Process -Id $proc.ProcessId }
```

Expected: benchmark window closes without stopping unrelated VS Code windows.

- [ ] **Step 4: Commit final tuning if needed**

If benchmark tuning required code changes, run:

```powershell
git add src
git commit -m "perf: tune large workspace hydration budgets" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no code changes were needed, skip this commit.

---

## Self-Review

- Spec coverage: deferred symbol hydration, partial symbol usability, provider-first behavior, Merkle invalidation, persistence, command gating, progress/benchmarking, and QMK validation are covered by Tasks 1-8.
- Placeholder scan: this plan avoids placeholder markers and gives concrete files, commands, and code snippets for each implementation step.
- Type consistency: `SymbolHydrationPlanItem`, `SymbolHydrationScheduler`, `PersistedSymbolHydrationState`, and `IndexBenchmarkRecorder` names are consistent across tasks.
