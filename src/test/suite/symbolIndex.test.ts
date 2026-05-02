import * as assert from 'node:assert/strict';
import { SymbolIndex } from '../../indexes/symbolIndex';

suite('SymbolIndex', () => {
  test('marks fallback symbols as approximate', () => {
    const index = new SymbolIndex();

    index.replaceForFile('src/service.ts', [
      {
        name: 'UserService',
        kind: 5,
        containerName: 'services',
        uri: 'file:///c:/ws/src/service.ts',
        startLine: 4,
        startColumn: 1,
        approximate: true
      }
    ]);

    const [symbol] = index.search('UserService');

    assert.equal(symbol?.name, 'UserService');
    assert.equal(symbol?.approximate, true);
  });
});
