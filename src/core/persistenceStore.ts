import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class PersistenceStore {
  constructor(private readonly rootPath: string) {}

  async clearWorkspaceCache(workspaceId: string): Promise<void> {
    await fs.rm(path.join(this.rootPath, workspaceId), { force: true, recursive: true });
  }
}
