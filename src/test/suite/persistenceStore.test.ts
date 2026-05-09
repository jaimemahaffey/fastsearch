import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PersistenceStore, type PersistedWorkspaceSnapshot } from '../../core/persistenceStore';
import type { FileRecord } from '../../shared/types';
import type { SymbolRecord } from '../../indexes/symbolIndex';

type PersistedMerkleLeafEntry = {
  relativePath: string;
  uri: string;
  contentHash: string;
  size: number;
};

type PersistedMerkleSnapshot = {
  rootHash: string;
  subtreeHashes: Array<{ path: string; hash: string }>;
  leaves: PersistedMerkleLeafEntry[];
};

type PersistedTextEntry = {
  relativePath: string;
  uri: string;
  content: string;
  contentHash: string;
};

type PersistedSymbolEntry = {
  relativePath: string;
  contentHash: string | null;
  symbols: SymbolRecord[];
};

type PersistedIndexSnapshot = {
  metadata: {
    schemaVersion: number;
    workspaceId: string;
    configHash: string;
  };
  merkle: PersistedMerkleSnapshot;
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
    const store: PersistenceStoreContract = new PersistenceStore(rootPath);
    const snapshot: PersistedIndexSnapshot = {
      metadata: {
        schemaVersion: 1,
        workspaceId: 'workspace-id',
        configHash: 'cfg-123'
      },
      merkle: {
        rootHash: 'root-hash',
        subtreeHashes: [{ path: 'src', hash: 'src-hash' }],
        leaves: [{
          relativePath: 'src/app/main.ts',
          uri: 'file:///workspace/src/app/main.ts',
          contentHash: 'content-hash',
          size: 16
        }]
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
        content: 'const value = 1;',
        contentHash: 'content-hash'
      }],
      symbolIndex: [{
        relativePath: 'src/app/main.ts',
        contentHash: 'content-hash',
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
    const _contractCheck: PersistedWorkspaceSnapshot = {
      metadata: snapshot.metadata,
      merkle: snapshot.merkle,
      fileIndex: snapshot.fileIndex,
      textIndex: snapshot.textIndex,
      symbolIndex: snapshot.symbolIndex
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
    const store: PersistenceStoreContract = new PersistenceStore(rootPath);
    const snapshot: PersistedIndexSnapshot = {
      metadata: {
        schemaVersion: 1,
        workspaceId: 'workspace-id',
        configHash: 'cfg-123'
      },
      merkle: {
        rootHash: 'root-hash',
        subtreeHashes: [],
        leaves: []
      },
      fileIndex: [],
      textIndex: [],
      symbolIndex: []
    };
    const _contractCheck: PersistedWorkspaceSnapshot = {
      metadata: snapshot.metadata,
      merkle: snapshot.merkle,
      fileIndex: snapshot.fileIndex,
      textIndex: snapshot.textIndex,
      symbolIndex: snapshot.symbolIndex
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

  test('writes and reads available layer metadata with the workspace snapshot', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-persist-'));
    const store = new PersistenceStore(tempRoot);

    const snapshot: PersistedWorkspaceSnapshot = {
      metadata: {
        schemaVersion: 2,
        workspaceId: 'workspace-id',
        configHash: 'config-hash',
        layerState: {
          availableLayers: ['file', 'text'],
          activeLayer: 'symbol'
        }
      },
      merkle: {
        rootHash: 'root-hash',
        subtreeHashes: [],
        leaves: []
      },
      fileIndex: [],
      textIndex: [],
      symbolIndex: []
    };

    try {
      await store.writeWorkspaceSnapshot('workspace-id', snapshot);
      const restored = await store.readWorkspaceSnapshot('workspace-id');

      assert.deepEqual(restored?.metadata.layerState, {
        availableLayers: ['file', 'text'],
        activeLayer: 'symbol'
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
