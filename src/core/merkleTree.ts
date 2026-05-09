import { createHash } from 'node:crypto';

export type MerkleLeafRecord = {
  relativePath: string;
  uri: string;
  contentHash: string;
  size: number;
};

export type MerkleTreeSnapshot = {
  rootHash: string;
  subtreeHashes: Map<string, string>;
  leavesByPath: Map<string, MerkleLeafRecord>;
};

export type MerkleLeafDiff = {
  unchanged: MerkleLeafRecord[];
  changed: MerkleLeafRecord[];
  added: MerkleLeafRecord[];
  removed: MerkleLeafRecord[];
};

function hashParts(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

export function buildMerkleTree(leaves: MerkleLeafRecord[]): MerkleTreeSnapshot {
  const sortedLeaves = [...leaves].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const leavesByPath = new Map(sortedLeaves.map((leaf) => [leaf.relativePath, leaf]));
  const subtreeHashes = new Map<string, string>();

  for (const leaf of sortedLeaves) {
    const segments = leaf.relativePath.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const pathKey = segments.slice(0, index).join('/');
      const current = subtreeHashes.get(pathKey) ?? '';
      subtreeHashes.set(pathKey, hashParts([current, leaf.contentHash, leaf.relativePath]));
    }
  }

  const rootHash = hashParts(
    sortedLeaves.map((leaf) => `${leaf.relativePath}:${leaf.contentHash}`)
  );

  return { rootHash, subtreeHashes, leavesByPath };
}

export function diffMerkleLeaves(
  previous: Map<string, MerkleLeafRecord>,
  current: Map<string, MerkleLeafRecord>
): MerkleLeafDiff {
  const unchanged: MerkleLeafRecord[] = [];
  const changed: MerkleLeafRecord[] = [];
  const added: MerkleLeafRecord[] = [];
  const removed: MerkleLeafRecord[] = [];

  for (const [relativePath, currentLeaf] of current) {
    const previousLeaf = previous.get(relativePath);
    if (!previousLeaf) {
      added.push(currentLeaf);
      continue;
    }
    if (previousLeaf.contentHash === currentLeaf.contentHash) {
      unchanged.push(currentLeaf);
      continue;
    }
    changed.push(currentLeaf);
  }

  for (const [relativePath, previousLeaf] of previous) {
    if (!current.has(relativePath)) {
      removed.push(previousLeaf);
    }
  }

  return { unchanged, changed, added, removed };
}
