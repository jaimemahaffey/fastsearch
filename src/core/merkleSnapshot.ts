export type PersistedMerkleLeafEntry = {
  relativePath: string;
  uri: string;
  contentHash: string;
  size: number;
};

export type PersistedMerkleSnapshot = {
  rootHash: string;
  subtreeHashes: Array<{ path: string; hash: string }>;
  leaves: PersistedMerkleLeafEntry[];
};

export function toPersistedSubtreeHashes(subtreeHashes: Map<string, string>): Array<{ path: string; hash: string }> {
  return [...subtreeHashes.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([path, hash]) => ({ path, hash }));
}
