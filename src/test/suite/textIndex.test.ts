import * as assert from 'node:assert/strict';
import { TextIndex } from '../../indexes/textIndex';

suite('TextIndex', () => {
  test('returns preview snippets and 1-based line numbers', () => {
    const index = new TextIndex();

    index.upsert(
      'src/alpha.ts',
      'file:///c:/ws/src/alpha.ts',
      'export const alpha = 1;\nexport const beta = alpha + 1;'
    );

    const results = index.search('beta');

    assert.equal(results.length, 1);
    assert.equal(results[0]?.line, 2);
    assert.match(results[0]?.preview ?? '', /beta = alpha/);
  });
});
