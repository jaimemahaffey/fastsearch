import * as assert from 'node:assert/strict';
import { TextIndex } from '../../indexes/textIndex';
import { isEligibleTextFile } from '../../shared/fileEligibility';

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
    assert.equal(results[0]?.column, 14);
    assert.match(results[0]?.preview ?? '', /beta = alpha/);
  });

  test('returns no results for an empty query', () => {
    const index = new TextIndex();

    index.upsert(
      'src/alpha.ts',
      'file:///c:/ws/src/alpha.ts',
      'export const alpha = 1;\nexport const beta = alpha + 1;'
    );

    assert.deepEqual(index.search(''), []);
  });

  test('caps broad query results to avoid unbounded result arrays', () => {
    const index = new TextIndex();

    index.upsert(
      'src/alpha.ts',
      'file:///c:/ws/src/alpha.ts',
      Array.from({ length: 300 }, (_, index) => `alpha ${index + 1}`).join('\n')
    );

    const results = index.search('alpha');

    assert.equal(results.length, 200);
  });

  test('clear removes all indexed text content', () => {
    const index = new TextIndex();

    index.upsert(
      'src/alpha.ts',
      'file:///c:/ws/src/alpha.ts',
      'export const alpha = 1;\nexport const beta = alpha + 1;'
    );
    index.clear();

    assert.equal(index.isEmpty(), true);
    assert.deepEqual(index.search('alpha'), []);
  });

  test('delete removes text content for a single file', () => {
    const index = new TextIndex();

    index.upsert(
      'src/alpha.ts',
      'file:///c:/ws/src/alpha.ts',
      'export const alpha = 1;\nexport const beta = alpha + 1;'
    );
    index.upsert(
      'src/beta.ts',
      'file:///c:/ws/src/beta.ts',
      'export const beta = 2;'
    );

    index.delete('src/alpha.ts');

    assert.deepEqual(index.search('alpha'), []);
    assert.deepEqual(index.search('beta').map((match) => match.relativePath), ['src/beta.ts']);
  });
});

suite('isEligibleTextFile', () => {
  test('rejects root-level node_modules files from text indexing eligibility', () => {
    assert.equal(isEligibleTextFile('node_modules/foo.ts', 128, 1), false);
  });

  test('rejects nested node_modules files from text indexing eligibility', () => {
    assert.equal(isEligibleTextFile('packages/app/node_modules/foo.ts', 128, 1), false);
  });

  test('accepts files exactly at the maximum size boundary', () => {
    assert.equal(isEligibleTextFile('src/app/main.ts', 1024, 1), true);
  });
});
