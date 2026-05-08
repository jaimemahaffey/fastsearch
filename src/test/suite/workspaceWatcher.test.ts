import * as assert from 'node:assert/strict';
import { normalizeFileChange, shouldProcessUpdateJob } from '../../core/workspaceWatcher';

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

  test('filters update jobs under excluded heavy paths', () => {
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'node_modules/pkg/index.js' }), false);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'dist/extension.js' }), false);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: '.vscode-test/user-data/CachedData/chrome/js/cache_0' }), false);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: '.worktrees/add-command-mode-cycling/src/extension.ts' }), false);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'src/extension.ts' }), true);
  });

  test('respects configured include and exclude watcher filters', () => {
    const filters = {
      include: ['src/**/*.{ts,tsx}', 'src/**/[a-z]*.md'],
      exclude: ['src/generated/**', 'src/**/[!a-z]*.md']
    };

    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'notes/readme.md' }, filters), false);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'src/generated/api.ts' }, filters), false);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'src/Guides/README.md' }, filters), false);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'src/main.ts' }, filters), true);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'src/app/main.ts' }, filters), true);
    assert.equal(shouldProcessUpdateJob({ type: 'change', relativePath: 'src/docs/readme.md' }, filters), true);
  });
});
