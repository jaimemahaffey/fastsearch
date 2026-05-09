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

  test('clear removes all indexed file entries', () => {
    const index = new FileIndex();

    index.upsert('src/app/main.ts', 'c:/ws/src/app/main.ts');
    index.clear();

    assert.equal(index.isEmpty(), true);
    assert.deepEqual(index.search('main'), []);
  });

  test('removeForFile deletes one indexed file entry', () => {
    const index = new FileIndex();
    index.upsert('src/app/main.ts', 'c:/ws/src/app/main.ts');
    index.upsert('src/app/service.ts', 'c:/ws/src/app/service.ts');

    index.removeForFile('src/app/main.ts');

    assert.deepEqual(index.search('main'), []);
    assert.equal(index.search('service').length, 1);
  });

  test('moveFile preserves file metadata under the new relative path', () => {
    const index = new FileIndex();
    index.upsert('src/old.ts', 'file:///workspace/src/old.ts');

    index.moveFile('src/old.ts', 'src/new.ts', 'file:///workspace/src/new.ts');

    assert.deepEqual(index.search('old'), []);
    assert.deepEqual(index.search('new').map((entry) => entry.relativePath), ['src/new.ts']);
  });
});
