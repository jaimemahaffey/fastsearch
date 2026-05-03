import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PersistenceStore } from '../../core/persistenceStore';
import type { FileRecord } from '../../shared/types';
import type { SymbolRecord } from '../../indexes/symbolIndex';

type PersistedTextEntry = {
  relativePath: string;
  uri: string;
  content: string;
};

type PersistedSymbolEntry = {
  relativePath: string;
  symbols: SymbolRecord[];
};

type PersistedIndexSnapshot = {
  metadata: {
    schemaVersion: number;
    workspaceId: string;
    configHash: string;
  };
  fileIndex: FileRecord[];
  textIndex: PersistedTextEntry[];
  symbolIndex: PersistedSymbolEntry[];
};

type PersistenceStoreContract = PersistenceStore & {
  writeWorkspaceSnapshot: (workspaceId: string, snapshot: PersistedIndexSnapshot) => Promise<void>;
  readWorkspaceSnapshot: (workspaceId: string) => Promise<PersistedIndexSnapshot | undefined>;
};

suite('PersistenceStore', () => {
  test('writes and reads a structured workspace snapshot', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-persistence-'));
    const store = new PersistenceStore(rootPath) as PersistenceStoreContract;
    const snapshot: PersistedIndexSnapshot = {
      metadata: {
        schemaVersion: 1,
        workspaceId: 'workspace-id',
        configHash: 'cfg-123'
      },
      fileIndex: [{
        relativePath: 'src/app/main.ts',
        uri: 'file:///workspace/src/app/main.ts',
        basename: 'main.ts',
        extension: '.ts',
        tokens: ['src', 'app', 'main', 'ts']
      }],
      textIndex: [{
        relativePath: 'src/app/main.ts',
        uri: 'file:///workspace/src/app/main.ts',
        content: 'const value = 1;'
      }],
      symbolIndex: [{
        relativePath: 'src/app/main.ts',
        symbols: [{
          name: 'MainService',
          kind: 5,
          containerName: 'App',
          uri: 'file:///workspace/src/app/main.ts',
          startLine: 4,
          startColumn: 2,
          approximate: false
        }]
      }]
    };

    try {
      await store.writeWorkspaceSnapshot('workspace-id', snapshot);

      const restored = await store.readWorkspaceSnapshot('workspace-id');
      assert.deepEqual(restored, snapshot);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('clears a persisted workspace snapshot', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-persistence-'));
    const store = new PersistenceStore(rootPath) as PersistenceStoreContract;
    const snapshot: PersistedIndexSnapshot = {
      metadata: {
        schemaVersion: 1,
        workspaceId: 'workspace-id',
        configHash: 'cfg-123'
      },
      fileIndex: [],
      textIndex: [],
      symbolIndex: []
    };

    try {
      await store.writeWorkspaceSnapshot('workspace-id', snapshot);
      await store.clearWorkspaceCache('workspace-id');

      const restored = await store.readWorkspaceSnapshot('workspace-id');
      assert.equal(restored, undefined);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});
