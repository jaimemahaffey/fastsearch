import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SymbolRecord } from '../indexes/symbolIndex';
import type { FileRecord } from '../shared/types';

export type PersistedSnapshotMetadata = {
  schemaVersion: number;
  workspaceId: string;
  configHash: string;
};

export type PersistedTextEntry = {
  relativePath: string;
  uri: string;
  content: string;
};

export type PersistedSymbolEntry = {
  relativePath: string;
  symbols: SymbolRecord[];
};

export type PersistedWorkspaceSnapshot = {
  metadata: PersistedSnapshotMetadata;
  fileIndex: FileRecord[];
  textIndex: PersistedTextEntry[];
  symbolIndex: PersistedSymbolEntry[];
};

export class PersistenceStore {
  constructor(private readonly rootPath: string) {}

  async writeWorkspaceSnapshot(workspaceId: string, snapshot: PersistedWorkspaceSnapshot): Promise<void> {
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
