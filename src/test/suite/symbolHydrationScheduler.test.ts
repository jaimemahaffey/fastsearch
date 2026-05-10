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

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await nextTurn();
  }
  assert.fail(message);
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

  test('queues full-batch callbacks serially without duplicates under concurrent completions', async () => {
    const batches: number[] = [];
    const releaseCallbacks: Array<() => void> = [];
    let activeCallbacks = 0;
    let maxActiveCallbacks = 0;
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 4,
      batchSize: 2,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (): Promise<SymbolHydrationWorkerResult> => ({ status: 'hydrated' }),
      onBatchComplete: async (counts) => {
        activeCallbacks += 1;
        maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
        batches.push(counts.hydrated);
        await new Promise<void>((resolve) => releaseCallbacks.push(resolve));
        activeCallbacks -= 1;
      }
    });

    scheduler.enqueue([item('a.c'), item('b.c'), item('c.c'), item('d.c'), item('e.c'), item('f.c')], 1);
    const drainPromise = scheduler.drain();

    await waitUntil(() => releaseCallbacks.length === 1, 'first batch callback did not start');
    await nextTurn();
    await nextTurn();
    assert.deepEqual(batches, [2]);
    assert.equal(activeCallbacks, 1);

    releaseCallbacks.shift()?.();
    await waitUntil(() => releaseCallbacks.length === 1 && batches.length === 2, 'second batch callback did not start');
    assert.deepEqual(batches, [2, 4]);
    assert.equal(activeCallbacks, 1);

    releaseCallbacks.shift()?.();
    await waitUntil(() => releaseCallbacks.length === 1 && batches.length === 3, 'third batch callback did not start');
    assert.deepEqual(batches, [2, 4, 6]);
    assert.equal(activeCallbacks, 1);

    releaseCallbacks.shift()?.();
    await drainPromise;

    assert.deepEqual(batches, [2, 4, 6]);
    assert.equal(maxActiveCallbacks, 1);
  });

  test('continues queued checkpoint callbacks after a callback rejects', async () => {
    const batches: number[] = [];
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 4,
      batchSize: 2,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (): Promise<SymbolHydrationWorkerResult> => ({ status: 'hydrated' }),
      onBatchComplete: async (counts) => {
        batches.push(counts.hydrated);
        if (counts.hydrated === 2) {
          throw new Error('checkpoint failed');
        }
      }
    });

    scheduler.enqueue([item('a.c'), item('b.c'), item('c.c'), item('d.c')], 1);
    await assert.rejects(scheduler.drain(), /checkpoint failed/);
    await waitUntil(() => batches.length === 2, 'queued checkpoint callback did not run after rejection');

    assert.deepEqual(batches, [2, 4]);
  });

  test('counts worker exceptions as failed and continues draining', async () => {
    const processed: string[] = [];
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 2,
      batchSize: 10,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (entry): Promise<SymbolHydrationWorkerResult> => {
        processed.push(entry.relativePath);
        if (entry.relativePath === 'b.c') {
          throw new Error('provider failed');
        }
        return { status: 'hydrated' };
      }
    });

    scheduler.enqueue([item('a.c'), item('b.c'), item('c.c')], 1);
    await scheduler.drain();

    assert.deepEqual(processed.sort(), ['a.c', 'b.c', 'c.c']);
    assert.deepEqual(scheduler.getStatusCounts(), {
      queued: 0,
      running: 0,
      hydrated: 2,
      failed: 1,
      timedOut: 0,
      skipped: 0
    });
  });

  test('shares concurrent drain calls without exceeding configured concurrency', async () => {
    const processed: string[] = [];
    const releases: Array<() => void> = [];
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 2,
      batchSize: 10,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (entry): Promise<SymbolHydrationWorkerResult> => {
        processed.push(entry.relativePath);
        activeWorkers += 1;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeWorkers -= 1;
        return { status: 'hydrated' };
      }
    });

    scheduler.enqueue([item('a.c'), item('b.c'), item('c.c'), item('d.c')], 1);
    const firstDrain = scheduler.drain();
    const secondDrain = scheduler.drain();
    const sharedPromise = firstDrain === secondDrain;

    while (releases.length < 2) {
      await nextTurn();
    }
    while (releases.length > 0) {
      releases.shift()?.();
      await nextTurn();
    }
    while (releases.length > 0) {
      releases.shift()?.();
    }
    await Promise.all([firstDrain, secondDrain]);

    assert.equal(sharedPromise, true);
    assert.equal(maxActiveWorkers, 2);
    assert.deepEqual(processed.sort(), ['a.c', 'b.c', 'c.c', 'd.c']);
  });

  test('concurrent drain processes work enqueued while an empty drain is in flight', async () => {
    const processed: string[] = [];
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 2,
      batchSize: 10,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (entry): Promise<SymbolHydrationWorkerResult> => {
        processed.push(entry.relativePath);
        return { status: 'hydrated' };
      }
    });

    const firstDrain = scheduler.drain();
    scheduler.enqueue([item('late.c')], 1);
    const secondDrain = scheduler.drain();

    assert.equal(firstDrain, secondDrain);
    await secondDrain;

    assert.deepEqual(processed, ['late.c']);
    assert.deepEqual(scheduler.getStatusCounts(), {
      queued: 0,
      running: 0,
      hydrated: 1,
      failed: 0,
      timedOut: 0,
      skipped: 0
    });
  });

  test('cancel clears queued work while active workers finish current items', async () => {
    const processed: string[] = [];
    const releases: Array<() => void> = [];
    const scheduler = new SymbolHydrationScheduler({
      concurrency: 2,
      batchSize: 10,
      getGeneration: () => 1,
      isCurrent: () => true,
      worker: async (entry): Promise<SymbolHydrationWorkerResult> => {
        processed.push(entry.relativePath);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { status: 'hydrated' };
      }
    });

    scheduler.enqueue([item('a.c'), item('b.c'), item('c.c'), item('d.c')], 1);
    const drainPromise = scheduler.drain();

    while (releases.length < 2) {
      await nextTurn();
    }
    scheduler.cancel();

    assert.deepEqual(scheduler.getStatusCounts(), {
      queued: 0,
      running: 2,
      hydrated: 0,
      failed: 0,
      timedOut: 0,
      skipped: 2
    });

    for (const release of releases) {
      release();
    }
    await drainPromise;

    assert.deepEqual(processed.sort(), ['a.c', 'b.c']);
    assert.deepEqual(scheduler.getStatusCounts(), {
      queued: 0,
      running: 0,
      hydrated: 2,
      failed: 0,
      timedOut: 0,
      skipped: 2
    });
  });
});
