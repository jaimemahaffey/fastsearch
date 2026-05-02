import * as assert from 'node:assert/strict';
import { IndexCoordinator } from '../../core/indexCoordinator';

suite('IndexCoordinator', () => {
  test('clears persisted state before a rebuild starts', async () => {
    const events: string[] = [];
    const coordinator = new IndexCoordinator({
      clearPersistence: async () => { events.push('clear'); },
      buildWorkspace: async () => { events.push('build'); }
    });

    await coordinator.rebuild();

    assert.deepEqual(events, ['clear', 'build']);
  });
});
