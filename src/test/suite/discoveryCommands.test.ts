import * as assert from 'node:assert/strict';
import { chooseImplementationResults } from '../../commands/findImplementations';
import { chooseUsageResults } from '../../commands/findUsages';

suite('discoveryCommands', () => {
  test('prefers provider results over approximate local matches', () => {
    const results = chooseUsageResults(
      [{ uri: 'file:///provider.ts', line: 3, approximate: false }],
      [{ uri: 'file:///fallback.ts', line: 9, approximate: true }]
    );

    assert.deepEqual(results, [{ uri: 'file:///provider.ts', line: 3, approximate: false }]);
  });

  test('prefers provider implementation results over approximate local matches', () => {
    const results = chooseImplementationResults(
      [{ uri: 'file:///provider.ts', line: 7, approximate: false }],
      [{ uri: 'file:///fallback.ts', line: 11, approximate: true }]
    );

    assert.deepEqual(results, [{ uri: 'file:///provider.ts', line: 7, approximate: false }]);
  });
});
