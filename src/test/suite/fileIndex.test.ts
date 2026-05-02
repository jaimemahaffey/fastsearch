import * as assert from 'node:assert/strict';
import { FileIndex } from '../../indexes/fileIndex';

suite('FileIndex', () => {
  test('stores file metadata and ranks basename matches first', () => {
    const index = new FileIndex();

    index.upsert('src/app/main.ts', 'c:/ws/src/app/main.ts');
    index.upsert('test/main.test.ts', 'c:/ws/test/main.test.ts');

    const results = index.search('main');

    assert.equal(results[0]?.relativePath, 'src/app/main.ts');
    assert.equal(results[1]?.relativePath, 'test/main.test.ts');
  });
});
