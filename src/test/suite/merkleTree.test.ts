import * as assert from 'node:assert/strict';
import {
  buildMerkleTree,
  diffMerkleLeaves,
  type MerkleLeafRecord
} from '../../core/merkleTree';
import { hashContent } from '../../core/contentHash';

suite('merkleTree', () => {
  test('buildMerkleTree produces a deterministic root regardless of input order', () => {
    const leafA: MerkleLeafRecord = {
      relativePath: 'src/app/main.ts',
      uri: 'file:///workspace/src/app/main.ts',
      contentHash: hashContent('const alpha = 1;\n'),
      size: 17
    };
    const leafB: MerkleLeafRecord = {
      relativePath: 'src/app/service.ts',
      uri: 'file:///workspace/src/app/service.ts',
      contentHash: hashContent('export class Service {}\n'),
      size: 25
    };

    const forward = buildMerkleTree([leafA, leafB]);
    const reversed = buildMerkleTree([leafB, leafA]);

    assert.equal(forward.rootHash, reversed.rootHash);
    assert.deepEqual(forward.leavesByPath.get('src/app/main.ts'), leafA);
    assert.deepEqual(forward.leavesByPath.get('src/app/service.ts'), leafB);
  });

  test('diffMerkleLeaves classifies unchanged, changed, added, and removed paths', () => {
    const previous = new Map<string, MerkleLeafRecord>([
      ['src/unchanged.ts', {
        relativePath: 'src/unchanged.ts',
        uri: 'file:///workspace/src/unchanged.ts',
        contentHash: 'same',
        size: 4
      }],
      ['src/changed.ts', {
        relativePath: 'src/changed.ts',
        uri: 'file:///workspace/src/changed.ts',
        contentHash: 'before',
        size: 6
      }],
      ['src/removed.ts', {
        relativePath: 'src/removed.ts',
        uri: 'file:///workspace/src/removed.ts',
        contentHash: 'gone',
        size: 4
      }]
    ]);
    const current = new Map<string, MerkleLeafRecord>([
      ['src/unchanged.ts', {
        relativePath: 'src/unchanged.ts',
        uri: 'file:///workspace/src/unchanged.ts',
        contentHash: 'same',
        size: 4
      }],
      ['src/changed.ts', {
        relativePath: 'src/changed.ts',
        uri: 'file:///workspace/src/changed.ts',
        contentHash: 'after',
        size: 5
      }],
      ['src/added.ts', {
        relativePath: 'src/added.ts',
        uri: 'file:///workspace/src/added.ts',
        contentHash: 'new',
        size: 3
      }]
    ]);

    const diff = diffMerkleLeaves(previous, current);

    assert.deepEqual(diff.unchanged.map((leaf) => leaf.relativePath), ['src/unchanged.ts']);
    assert.deepEqual(diff.changed.map((entry) => entry.relativePath), ['src/changed.ts']);
    assert.deepEqual(diff.added.map((leaf) => leaf.relativePath), ['src/added.ts']);
    assert.deepEqual(diff.removed.map((leaf) => leaf.relativePath), ['src/removed.ts']);
  });
});
