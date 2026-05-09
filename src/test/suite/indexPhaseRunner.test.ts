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
