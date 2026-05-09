import * as assert from 'node:assert/strict';
import {
  buildMerkleTree,
  diffMerkleLeaves,
  type MerkleLeafRecord
} from '../../core/merkleTree';
import { hashContent } from '../../core/contentHash';
import { toPersistedSubtreeHashes } from '../../core/merkleSnapshot';

function leafRecord(relativePath: string, content: string): MerkleLeafRecord {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  return {
    relativePath: normalizedPath,
    uri: `file:///workspace/${normalizedPath}`,
    contentHash: hashContent(content),
    size: content.length
  };
}

function hashDirectChildren(entries: Array<[string, string]>): string {
  return hashContent(
    entries
      .slice()
      .sort(([leftName], [rightName]) => leftName < rightName ? -1 : leftName > rightName ? 1 : 0)
      .map(([name, hash]) => `${name}:${hash}`)
      .join('\n')
  );
}

suite('merkleTree', () => {
  test('buildMerkleTree produces a deterministic root regardless of input order', () => {
    const leafA = leafRecord('src/app/main.ts', 'const alpha = 1;\n');
    const leafB = leafRecord('src/app/service.ts', 'export class Service {}\n');

    const forward = buildMerkleTree([leafA, leafB]);
    const reversed = buildMerkleTree([leafB, leafA]);

    assert.equal(forward.rootHash, reversed.rootHash);
    assert.deepEqual(forward.leavesByPath.get('src/app/main.ts'), leafA);
    assert.deepEqual(forward.leavesByPath.get('src/app/service.ts'), leafB);
  });

  test('buildMerkleTree normalizes Windows-style paths before hashing and keying', () => {
    const forward = buildMerkleTree([
      leafRecord('src/app/main.ts', 'const alpha = 1;\n'),
      leafRecord('src/app/service.ts', 'export class Service {}\n')
    ]);
    const windows = buildMerkleTree([
      {
        relativePath: 'src\\app\\main.ts',
        uri: 'file:///workspace/src/app/main.ts',
        contentHash: hashContent('const alpha = 1;\n'),
        size: 'const alpha = 1;\n'.length
      },
      {
        relativePath: 'src\\app\\service.ts',
        uri: 'file:///workspace/src/app/service.ts',
        contentHash: hashContent('export class Service {}\n'),
        size: 'export class Service {}\n'.length
      }
    ]);

    assert.equal(windows.rootHash, forward.rootHash);
    assert.equal(windows.subtreeHashes.get('src'), forward.subtreeHashes.get('src'));
    assert.equal(windows.subtreeHashes.get('src/app'), forward.subtreeHashes.get('src/app'));
    assert.deepEqual(windows.leavesByPath.get('src/app/main.ts'), forward.leavesByPath.get('src/app/main.ts'));
    assert.deepEqual(windows.leavesByPath.get('src/app/service.ts'), forward.leavesByPath.get('src/app/service.ts'));
  });

  test('buildMerkleTree rejects duplicate normalized leaf paths', () => {
    assert.throws(
      () => buildMerkleTree([
        leafRecord('src/app/main.ts', 'const alpha = 1;\n'),
        {
          relativePath: 'src\\app\\main.ts',
          uri: 'file:///workspace/src/app/main.ts',
          contentHash: hashContent('const beta = 2;\n'),
          size: 'const beta = 2;\n'.length
        }
      ]),
      /duplicate normalized leaf path/i
    );
  });

  test('buildMerkleTree derives subtree hashes from sorted direct children', () => {
    const alpha = leafRecord('src/app/alpha.ts', 'alpha\n');
    const nested = leafRecord('src/app/nested/file.ts', 'nested\n');
    const zeta = leafRecord('src/app/zeta.ts', 'zeta\n');
    const readme = leafRecord('src/readme.md', 'readme\n');

    const forward = buildMerkleTree([alpha, nested, zeta, readme]);
    const reversed = buildMerkleTree([readme, zeta, nested, alpha]);

    const nestedHash = hashDirectChildren([
      ['file.ts', nested.contentHash]
    ]);
    const appHash = hashDirectChildren([
      ['alpha.ts', alpha.contentHash],
      ['nested', nestedHash],
      ['zeta.ts', zeta.contentHash]
    ]);
    const srcHash = hashDirectChildren([
      ['app', appHash],
      ['readme.md', readme.contentHash]
    ]);
    const workspaceHash = hashDirectChildren([
      ['src', srcHash]
    ]);

    assert.equal(forward.rootHash, workspaceHash);
    assert.equal(reversed.rootHash, workspaceHash);
    assert.equal(forward.subtreeHashes.get('src/app/nested'), nestedHash);
    assert.equal(forward.subtreeHashes.get('src/app'), appHash);
    assert.equal(forward.subtreeHashes.get('src'), srcHash);
    assert.equal(reversed.subtreeHashes.get('src/app'), appHash);
    assert.equal(reversed.subtreeHashes.get('src'), srcHash);
  });

  test('buildMerkleTree orders non-ASCII path segments with locale-independent comparisons', () => {
    const zebra = leafRecord('src/z.ts', 'zebra\n');
    const umlaut = leafRecord('src/ä.ts', 'umlaut\n');

    const tree = buildMerkleTree([umlaut, zebra]);
    const srcHash = hashDirectChildren([
      ['z.ts', zebra.contentHash],
      ['ä.ts', umlaut.contentHash]
    ]);
    const rootHash = hashDirectChildren([
      ['src', srcHash]
    ]);

    assert.equal(tree.subtreeHashes.get('src'), srcHash);
    assert.equal(tree.rootHash, rootHash);
  });

  test('toPersistedSubtreeHashes uses locale-independent ordering', () => {
    const subtreeHashes = new Map<string, string>([
      ['ä', 'umlaut'],
      ['z', 'zebra']
    ]);

    assert.deepEqual(toPersistedSubtreeHashes(subtreeHashes), [
      { path: 'z', hash: 'zebra' },
      { path: 'ä', hash: 'umlaut' }
    ]);
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
