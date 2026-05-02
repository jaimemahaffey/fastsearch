import * as assert from 'node:assert/strict';
import { IndexCoordinator } from '../../core/indexCoordinator';

suite('IndexCoordinator', () => {
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
});
