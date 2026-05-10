import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SymbolRecord } from '../indexes/symbolIndex';
import type { SemanticIndexFileEntry } from '../semantics/semanticIndex';
import type { FileRecord, PersistedLayerState, PersistedSymbolHydrationState } from '../shared/types';
import type { PersistedMerkleSnapshot } from './merkleSnapshot';

export type PersistedSnapshotMetadata = {
  schemaVersion: number;
  workspaceId: string;
  configHash: string;
  layerState?: PersistedLayerState;
  symbolHydration?: PersistedSymbolHydrationState;
};

export type PersistedTextEntry = {
  relativePath: string;
  uri: string;
  content: string;
  contentHash: string;
};

export type PersistedSymbolEntry = {
  relativePath: string;
  contentHash: string | null;
  symbols: SymbolRecord[];
};

export type PersistedWorkspaceSnapshot = {
  metadata: PersistedSnapshotMetadata;
  merkle: PersistedMerkleSnapshot;
  fileIndex: FileRecord[];
  textIndex: PersistedTextEntry[];
  symbolIndex: PersistedSymbolEntry[];
  semanticIndex?: SemanticIndexFileEntry[];
};

export class PersistenceStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootPath: string) {}

  async writeWorkspaceSnapshot(workspaceId: string, snapshot: PersistedWorkspaceSnapshot): Promise<void> {
    const previousWrite = this.writeQueues.get(workspaceId) ?? Promise.resolve();
    const currentWrite = previousWrite
      .catch(() => undefined)
      .then(() => this.writeWorkspaceSnapshotNow(workspaceId, snapshot));
    this.writeQueues.set(workspaceId, currentWrite);

    try {
      await currentWrite;
    } finally {
      if (this.writeQueues.get(workspaceId) === currentWrite) {
        this.writeQueues.delete(workspaceId);
      }
    }
  }

  private async writeWorkspaceSnapshotNow(workspaceId: string, snapshot: PersistedWorkspaceSnapshot): Promise<void> {
    const workspacePath = path.join(this.rootPath, workspaceId);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, 'snapshot.json'),
      JSON.stringify(snapshot, null, 2),
      'utf8'
    );
  }

  async readWorkspaceSnapshot(workspaceId: string): Promise<PersistedWorkspaceSnapshot | undefined> {
    try {
      const contents = await fs.readFile(path.join(this.rootPath, workspaceId, 'snapshot.json'), 'utf8');
      return JSON.parse(contents) as PersistedWorkspaceSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  async clearWorkspaceCache(workspaceId: string): Promise<void> {
    await fs.rm(path.join(this.rootPath, workspaceId), { force: true, recursive: true });
  }
}
