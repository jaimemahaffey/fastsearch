import * as assert from 'node:assert/strict';
import { requiresRebuild } from '../../configuration';

suite('configuration', () => {
  test('requires rebuild for watched configuration keys', () => {
    const watchedKeys = [
      'fastIndexer.include',
      'fastIndexer.exclude',
      'fastIndexer.maxFileSizeKb',
      'fastIndexer.symbolFallback'
    ];

    for (const watchedKey of watchedKeys) {
      const event = {
        affectsConfiguration: (key: string) => key === watchedKey
      };

      assert.equal(requiresRebuild(event as never), true, `${watchedKey} should trigger a rebuild`);
    }
  });

  test('does not require rebuild for unrelated configuration keys', () => {
    const event = {
      affectsConfiguration: (key: string) => key === 'fastIndexer.debounceMs'
    };

    assert.equal(requiresRebuild(event as never), false);
  });
});
