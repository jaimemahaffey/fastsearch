import * as assert from 'node:assert/strict';
import { FileIndex } from '../../indexes/fileIndex';

suite('FileIndex', () => {
  test('upsert stores derived file metadata in indexed records', () => {
    const index = new FileIndex();

    index.upsert('src/app/main.ts', 'c:/ws/src/app/main.ts');

    const results = index.search('main');

    assert.deepEqual(results[0], {
      relativePath: 'src/app/main.ts',
      uri: 'c:/ws/src/app/main.ts',
      basename: 'main.ts',
      extension: '.ts',
      tokens: ['src', 'app', 'main', 'ts']
    });
  });

  test('search ranks basename matches ahead of path-only matches', () => {
    const index = new FileIndex();

    index.upsert('src/app/main.ts', 'c:/ws/src/app/main.ts');
    index.upsert('src/main/helpers/bootstrap.ts', 'c:/ws/src/main/helpers/bootstrap.ts');

    const results = index.search('main');

    assert.deepEqual(results.map((result) => result.relativePath), [
      'src/app/main.ts',
      'src/main/helpers/bootstrap.ts'
    ]);
    assert.equal(results[0]?.basename, 'main.ts');
    assert.equal(results[1]?.basename, 'bootstrap.ts');
  });
});
