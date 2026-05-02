import * as assert from 'node:assert/strict';
import { normalizeFileChange } from '../../core/workspaceWatcher';

suite('workspaceWatcher', () => {
  test('coalesces rename into delete plus create jobs', () => {
    const jobs = normalizeFileChange({
      type: 'rename',
      from: 'src/old-name.ts',
      to: 'src/new-name.ts'
    });

    assert.deepEqual(jobs, [
      { type: 'delete', relativePath: 'src/old-name.ts' },
      { type: 'create', relativePath: 'src/new-name.ts' }
    ]);
  });
});
