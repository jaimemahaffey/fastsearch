import { createHash } from 'node:crypto';
import { compareOrdinal } from './ordinalCompare';

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

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

type MerkleNode = {
  children: Map<string, MerkleNode>;
  leaf?: MerkleLeafRecord;
};

function createNode(): MerkleNode {
  return { children: new Map<string, MerkleNode>() };
}

function hashDirectChildren(entries: Array<[string, string]>): string {
  return hashParts(
    entries
      .slice()
      .sort(([leftName], [rightName]) => compareOrdinal(leftName, rightName))
      .map(([name, hash]) => `${name}:${hash}`)
  );
}

export function buildMerkleTree(leaves: MerkleLeafRecord[]): MerkleTreeSnapshot {
  const normalizedLeaves = leaves.map((leaf) => {
    const relativePath = normalizeRelativePath(leaf.relativePath);
    return relativePath === leaf.relativePath
      ? leaf
      : { ...leaf, relativePath };
  });
  const seenPaths = new Set<string>();
  for (const leaf of normalizedLeaves) {
    if (seenPaths.has(leaf.relativePath)) {
      throw new Error(`Cannot build Merkle tree: duplicate normalized leaf path "${leaf.relativePath}"`);
    }
    seenPaths.add(leaf.relativePath);
  }
  const sortedLeaves = [...normalizedLeaves].sort((left, right) => compareOrdinal(left.relativePath, right.relativePath));
  const leavesByPath = new Map(sortedLeaves.map((leaf) => [leaf.relativePath, leaf]));
  const root = createNode();

  for (const leaf of sortedLeaves) {
    const segments = leaf.relativePath.split('/');
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const pathKey = segments.slice(0, index + 1).join('/');
      let child = current.children.get(segment);
      if (!child) {
        child = createNode();
        current.children.set(segment, child);
      }
      if (index < segments.length - 1 && child.leaf) {
        throw new Error(`Cannot build Merkle tree: file path "${pathKey}" has nested descendants`);
      }
      if (index === segments.length - 1) {
        if (child.children.size > 0) {
          throw new Error(`Cannot build Merkle tree: path "${leaf.relativePath}" collides with an existing directory`);
        }
        child.leaf = leaf;
      }
      current = child;
    }
  }

  const subtreeHashes = new Map<string, string>();

  function hashNode(node: MerkleNode, pathKey: string): string {
    if (node.leaf && node.children.size === 0) {
      return node.leaf.contentHash;
    }

    const childEntries = [...node.children.entries()].map(([name, child]) => [name, hashNode(child, pathKey ? `${pathKey}/${name}` : name)] as const);
    const hash = hashDirectChildren(childEntries.map(([name, childHash]) => [name, childHash]));
    if (pathKey) {
      subtreeHashes.set(pathKey, hash);
    }
    return hash;
  }

  const rootHash = hashNode(root, '');

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
