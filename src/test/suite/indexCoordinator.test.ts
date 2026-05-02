import * as assert from 'node:assert/strict';
import { IndexCoordinator } from '../../core/indexCoordinator';

suite('IndexCoordinator', () => {
  test('transitions through explicit coordinator states', () => {
    const coordinator = new IndexCoordinator({
      clearIndexes: () => undefined,
      clearPersistence: async () => undefined,
      buildWorkspace: async () => undefined
    });

    assert.equal(coordinator.getState(), 'idle');

    coordinator.markWarming();
    assert.equal(coordinator.getState(), 'warming');

    coordinator.markReady();
    assert.equal(coordinator.getState(), 'ready');

    coordinator.markStale();
    assert.equal(coordinator.getState(), 'stale');
  });

  test('clears persisted state before a rebuild starts', async () => {
    const events: string[] = [];
    const coordinator = new IndexCoordinator({
      clearIndexes: () => { events.push('memory'); },
      clearPersistence: async () => { events.push('clear'); },
      buildWorkspace: async () => { events.push('build'); }
    });

    await coordinator.rebuild();

    assert.deepEqual(events, ['memory', 'clear', 'build']);
  });

  test('does not rebuild the workspace when clearing persisted state fails', async () => {
    const events: string[] = [];
    const expected = new Error('clear failed');
    const coordinator = new IndexCoordinator({
      clearIndexes: () => { events.push('memory'); },
      clearPersistence: async () => {
        events.push('clear');
        throw expected;
      },
      buildWorkspace: async () => { events.push('build'); }
    });

    await assert.rejects(() => coordinator.rebuild(), expected);

    assert.deepEqual(events, ['memory', 'clear']);
  });

  test('transitions to rebuilding during rebuild and ready after success', async () => {
    let resolveBuild: (() => void) | undefined;
    const coordinator = new IndexCoordinator({
      clearIndexes: () => undefined,
      clearPersistence: async () => undefined,
      buildWorkspace: async () => {
        await new Promise<void>((resolve) => {
          resolveBuild = resolve;
        });
      }
    });

    const rebuildPromise = coordinator.rebuild();

    assert.equal(coordinator.getState(), 'rebuilding');

    await Promise.resolve();
    await Promise.resolve();
    assert.ok(resolveBuild, 'build workspace should start during rebuild');

    resolveBuild?.();
    await rebuildPromise;

    assert.equal(coordinator.getState(), 'ready');
  });

  test('marks the coordinator stale and rethrows when rebuilding fails', async () => {
    const expected = new Error('build failed');
    const coordinator = new IndexCoordinator({
      clearIndexes: () => undefined,
      clearPersistence: async () => undefined,
      buildWorkspace: async () => {
        throw expected;
      }
    });

    await assert.rejects(() => coordinator.rebuild(), expected);

    assert.equal(coordinator.getState(), 'stale');
  });
});
