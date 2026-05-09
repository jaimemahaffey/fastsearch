import * as assert from 'node:assert/strict';
import { SymbolIndex, type SymbolRecord } from '../../indexes/symbolIndex';

suite('SymbolIndex', () => {
  test('sorts provider-backed matches ahead of approximate matches', () => {
    const index = new SymbolIndex();

    index.replaceForFile('src/service.ts', [
      createSymbol({ name: 'UserService', approximate: true }),
      createSymbol({ name: 'UserService', approximate: false })
    ]);

    const results = index.search('UserService');

    assert.equal(results.map((symbol) => symbol.approximate).join(','), 'false,true');
  });

  test('sorts alphabetically within the same approximation tier', () => {
    const index = new SymbolIndex();

    index.replaceForFile('src/service.ts', [
      createSymbol({ name: 'ZooService', approximate: false }),
      createSymbol({ name: 'AlphaService', approximate: false }),
      createSymbol({ name: 'BetaService', approximate: true }),
      createSymbol({ name: 'AaronService', approximate: true })
    ]);

    const results = index.search('Service');

    assert.deepEqual(results.map((symbol) => `${symbol.approximate}:${symbol.name}`), [
      'false:AlphaService',
      'false:ZooService',
      'true:AaronService',
      'true:BetaService'
    ]);
  });

  test('replaceForFile replaces the existing symbols for the file', () => {
    const index = new SymbolIndex();

    index.replaceForFile('src/service.ts', [
      createSymbol({ name: 'OldService', approximate: true })
    ]);
    index.replaceForFile('src/service.ts', [
      createSymbol({ name: 'NewService', approximate: false })
    ]);

    assert.deepEqual(index.search('Service').map((symbol) => symbol.name), ['NewService']);
  });

  test('treats indexes with only empty symbol arrays as empty', () => {
    const index = new SymbolIndex();

    index.replaceForFile('src/empty.ts', []);

    assert.equal(index.isEmpty(), true);
  });

  test('clear removes all indexed symbols', () => {
    const index = new SymbolIndex();

    index.replaceForFile('src/service.ts', [
      createSymbol({ name: 'UserService', approximate: false })
    ]);
    index.clear();

    assert.equal(index.isEmpty(), true);
    assert.deepEqual(index.search('UserService'), []);
  });

  test('removeForFile deletes symbols for one file only', () => {
    const index = new SymbolIndex();
    index.replaceForFile('src/service.ts', [createSymbol({ name: 'UserService' })]);
    index.replaceForFile('src/model.ts', [createSymbol({ name: 'UserModel' })]);

    index.removeForFile('src/service.ts');

    assert.deepEqual(index.search('UserService'), []);
    assert.deepEqual(index.search('UserModel').map((symbol) => symbol.name), ['UserModel']);
  });

  test('moveFile updates symbols to the new file uri', () => {
    const index = new SymbolIndex();
    index.replaceForFile('src/service.ts', [createSymbol({ name: 'UserService', uri: 'file:///c:/ws/src/service.ts' })]);

    index.moveFile('src/service.ts', 'src/renamed.ts', 'file:///c:/ws/src/renamed.ts');

    assert.deepEqual(index.search('UserService').map((symbol) => symbol.uri), ['file:///c:/ws/src/renamed.ts']);
    assert.deepEqual(index.search('UserService').map((symbol) => symbol.name), ['UserService']);
  });
});

function createSymbol(overrides: Partial<SymbolRecord> & Pick<SymbolRecord, 'name'>): SymbolRecord {
  return {
    name: overrides.name,
    kind: overrides.kind ?? 5,
    containerName: overrides.containerName,
    uri: overrides.uri ?? 'file:///c:/ws/src/service.ts',
    startLine: overrides.startLine ?? 0,
    startColumn: overrides.startColumn ?? 0,
    approximate: overrides.approximate ?? false
  };
}
