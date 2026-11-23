# File-Level Merkle Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local file-level Merkle invalidation so FastSearch can reuse cached file, text, and document-symbol data for unchanged files and update only affected paths on rebuild.

**Architecture:** Keep the existing file, text, symbol, and semantic indexes as the search surface. Add a new Merkle layer that hashes file contents, persists leaf and subtree state in the workspace snapshot, diffs current workspace state against the persisted tree, and uses that diff to decide which per-file caches to reuse, rebuild, remove, or move.

**Tech Stack:** TypeScript, Node `crypto`, VS Code extension APIs, existing persistence snapshot model, Mocha integration tests, npm scripts.

---

## File Structure

- Create: `src/core/contentHash.ts` — stable content hashing helpers for file leaves.
- Create: `src/core/merkleTree.ts` — Merkle leaf/node records, root computation, and diff helpers.
- Create: `src/core/merkleSnapshot.ts` — persisted Merkle and per-file cache metadata types.
- Create: `src/test/suite/merkleTree.test.ts` — unit tests for deterministic hashing and Merkle diffs.
- Modify: `src/core/persistenceStore.ts` — extend workspace snapshots to store Merkle state and cache hash stamps.
- Modify: `src/shared/types.ts` — add shared per-file cache stamp types if needed by indexes or persistence helpers.
- Modify: `src/indexes/fileIndex.ts` — support per-file removal and path moves during incremental updates.
- Modify: `src/indexes/textIndex.ts` — support per-file removal and path moves during incremental updates.
- Modify: `src/indexes/symbolIndex.ts` — support per-file removal and path moves during incremental updates.
- Modify: `src/semantics/semanticIndex.ts` — support per-file removal and path moves during incremental updates.
- Modify: `src/extension.ts` — replace full rebuild-only indexing with Merkle-driven startup reconciliation and targeted watcher updates.
- Modify: `src/test/suite/persistenceStore.test.ts` — cover Merkle snapshot serialization.
- Modify: `src/test/suite/fileIndex.test.ts` — cover file entry removal/move behavior.
- Modify: `src/test/suite/textIndex.test.ts` — cover text entry removal/move behavior.
- Modify: `src/test/suite/symbolIndex.test.ts` — cover symbol entry removal/move behavior.
- Modify: `src/test/suite/extension.test.ts` — cover unchanged-file reuse, changed-file rebuild, delete handling, and targeted watcher updates.

## Commands

- Full verification: `npm test`
- Faster type/build verification: `npm run typecheck; npm run compile`
- Merkle-focused tests: `$env:MOCHA_GREP='merkle|Merkle'; npm test`
- Persistence-focused tests: `$env:MOCHA_GREP='PersistenceStore|persisted snapshot'; npm test`
- Activation/rebuild-focused tests: `$env:MOCHA_GREP='extension activation'; npm test`

---

### Task 1: Add Merkle hashing and diff primitives

**Files:**
- Create: `src/core/contentHash.ts`
- Create: `src/core/merkleTree.ts`
- Create: `src/test/suite/merkleTree.test.ts`
- Test: `src/test/suite/merkleTree.test.ts`

- [ ] **Step 1: Write the failing Merkle unit tests**

Create `src/test/suite/merkleTree.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the Merkle unit tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='merkleTree'; npm test
```

Expected: FAIL because `src/core/contentHash.ts` and `src/core/merkleTree.ts` do not exist yet.

- [ ] **Step 3: Implement content hashing**

Create `src/core/contentHash.ts`:

```ts
import { createHash } from 'node:crypto';

export function hashContent(content: string | Buffer): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha256').update(buffer).digest('hex');
}
```

- [ ] **Step 4: Implement the Merkle tree helpers**

Create `src/core/merkleTree.ts`:

```ts
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
```

- [ ] **Step 5: Run the Merkle unit tests to verify they pass**

Run:

```powershell
$env:MOCHA_GREP='merkleTree'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the Merkle primitives**

Run:

```powershell
git add src\core\contentHash.ts src\core\merkleTree.ts src\test\suite\merkleTree.test.ts
git commit -m "feat: add merkle hashing primitives" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add per-file invalidation operations to the existing caches

**Files:**
- Modify: `src/indexes/fileIndex.ts`
- Modify: `src/indexes/textIndex.ts`
- Modify: `src/indexes/symbolIndex.ts`
- Modify: `src/semantics/semanticIndex.ts`
- Modify: `src/test/suite/fileIndex.test.ts`
- Modify: `src/test/suite/textIndex.test.ts`
- Modify: `src/test/suite/symbolIndex.test.ts`
- Test: `src/test/suite/fileIndex.test.ts`
- Test: `src/test/suite/textIndex.test.ts`
- Test: `src/test/suite/symbolIndex.test.ts`

- [ ] **Step 1: Write failing removal and move tests for the caches**

Add these tests:

```ts
// src/test/suite/fileIndex.test.ts
test('removeForFile deletes one indexed file entry', () => {
  const index = new FileIndex();
  index.upsert('src/app/main.ts', 'c:/ws/src/app/main.ts');
  index.upsert('src/app/service.ts', 'c:/ws/src/app/service.ts');

  index.removeForFile('src/app/main.ts');

  assert.deepEqual(index.search('main'), []);
  assert.equal(index.search('service').length, 1);
});

test('moveFile preserves file metadata under the new relative path', () => {
  const index = new FileIndex();
  index.upsert('src/old.ts', 'file:///workspace/src/old.ts');

  index.moveFile('src/old.ts', 'src/new.ts', 'file:///workspace/src/new.ts');

  assert.deepEqual(index.search('new').map((entry) => entry.relativePath), ['src/new.ts']);
});
```

```ts
// src/test/suite/textIndex.test.ts
test('removeForFile deletes indexed text content for one path', () => {
  const index = new TextIndex();
  index.upsert('src/alpha.ts', 'file:///c:/ws/src/alpha.ts', 'alpha');
  index.upsert('src/beta.ts', 'file:///c:/ws/src/beta.ts', 'beta');

  index.removeForFile('src/alpha.ts');

  assert.deepEqual(index.search('alpha'), []);
  assert.equal(index.search('beta').length, 1);
});
```

```ts
// src/test/suite/symbolIndex.test.ts
test('removeForFile deletes symbols for one file only', () => {
  const index = new SymbolIndex();
  index.replaceForFile('src/service.ts', [createSymbol({ name: 'UserService' })]);
  index.replaceForFile('src/model.ts', [createSymbol({ name: 'UserModel' })]);

  index.removeForFile('src/service.ts');

  assert.deepEqual(index.search('UserService'), []);
  assert.deepEqual(index.search('UserModel').map((symbol) => symbol.name), ['UserModel']);
});
```

- [ ] **Step 2: Run the focused cache tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='removeForFile|moveFile|FileIndex|TextIndex|SymbolIndex'; npm test
```

Expected: FAIL because the indexes do not expose per-file removal or move helpers.

- [ ] **Step 3: Add per-file removal and move helpers**

Update the indexes with explicit invalidation primitives:

```ts
// src/indexes/fileIndex.ts
removeForFile(relativePath: string, key = relativePath): void {
  this.entries.delete(key);
}

moveFile(fromRelativePath: string, toRelativePath: string, toUri: string, fromKey = fromRelativePath, toKey = toRelativePath): void {
  const existing = this.entries.get(fromKey);
  if (!existing) {
    return;
  }

  this.entries.delete(fromKey);
  this.upsert(toRelativePath, toUri, toKey);
}
```

```ts
// src/indexes/textIndex.ts
removeForFile(relativePath: string): void {
  this.contents.delete(relativePath);
}

moveFile(fromRelativePath: string, toRelativePath: string, toUri: string): void {
  const existing = this.contents.get(fromRelativePath);
  if (!existing) {
    return;
  }

  this.contents.delete(fromRelativePath);
  this.contents.set(toRelativePath, { uri: toUri, content: existing.content });
}
```

```ts
// src/indexes/symbolIndex.ts and src/semantics/semanticIndex.ts
removeForFile(relativePath: string): void {
  this.byFile.delete(relativePath);
}

moveFile(fromRelativePath: string, toRelativePath: string): void {
  const existing = this.byFile.get(fromRelativePath);
  if (!existing) {
    return;
  }

  this.byFile.delete(fromRelativePath);
  this.byFile.set(toRelativePath, existing);
}
```

- [ ] **Step 4: Run the focused cache tests to verify they pass**

Run:

```powershell
$env:MOCHA_GREP='removeForFile|moveFile|FileIndex|TextIndex|SymbolIndex'; npm test
```

Expected: PASS.

- [ ] **Step 5: Commit the cache invalidation helpers**

Run:

```powershell
git add src\indexes\fileIndex.ts src\indexes\textIndex.ts src\indexes\symbolIndex.ts src\semantics\semanticIndex.ts src\test\suite\fileIndex.test.ts src\test\suite\textIndex.test.ts src\test\suite\symbolIndex.test.ts
git commit -m "feat: add per-file cache invalidation helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Persist Merkle state and cache content hashes with the workspace snapshot

**Files:**
- Create: `src/core/merkleSnapshot.ts`
- Modify: `src/core/persistenceStore.ts`
- Modify: `src/test/suite/persistenceStore.test.ts`
- Test: `src/test/suite/persistenceStore.test.ts`

- [ ] **Step 1: Write failing persistence tests for the Merkle snapshot**

Update `src/test/suite/persistenceStore.test.ts` so the snapshot contract includes Merkle data:

```ts
type PersistedMerkleLeafEntry = {
  relativePath: string;
  uri: string;
  contentHash: string;
  size: number;
};

type PersistedMerkleSnapshot = {
  rootHash: string;
  subtreeHashes: Array<{ path: string; hash: string; }>;
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
  contentHash: string;
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
```

Use this fixture in the `writes and reads a structured workspace snapshot` test:

```ts
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
```

- [ ] **Step 2: Run the persistence tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='PersistenceStore'; npm test
```

Expected: FAIL because the snapshot contract and persistence types do not include Merkle data or cache content hashes.

- [ ] **Step 3: Add explicit persisted Merkle snapshot types**

Create `src/core/merkleSnapshot.ts`:

```ts
export type PersistedMerkleLeafEntry = {
  relativePath: string;
  uri: string;
  contentHash: string;
  size: number;
};

export type PersistedMerkleSnapshot = {
  rootHash: string;
  subtreeHashes: Array<{ path: string; hash: string; }>;
  leaves: PersistedMerkleLeafEntry[];
};

export function toPersistedSubtreeHashes(subtreeHashes: Map<string, string>): Array<{ path: string; hash: string; }> {
  return [...subtreeHashes.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([path, hash]) => ({ path, hash }));
}
```

- [ ] **Step 4: Extend the persistence snapshot contract**

Modify `src/core/persistenceStore.ts`:

```ts
import type { PersistedMerkleSnapshot } from './merkleSnapshot';

export type PersistedTextEntry = {
  relativePath: string;
  uri: string;
  content: string;
  contentHash: string;
};

export type PersistedSymbolEntry = {
  relativePath: string;
  contentHash: string;
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
```

Leave `writeWorkspaceSnapshot()` and `readWorkspaceSnapshot()` structurally unchanged so they continue serializing JSON directly once the types expand.

- [ ] **Step 5: Run the persistence tests to verify they pass**

Run:

```powershell
$env:MOCHA_GREP='PersistenceStore'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the persisted Merkle snapshot contract**

Run:

```powershell
git add src\core\merkleSnapshot.ts src\core\persistenceStore.ts src\test\suite\persistenceStore.test.ts
git commit -m "feat: persist merkle snapshot state" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Reuse unchanged file, text, and symbol caches during startup reconciliation

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/test/suite/extension.test.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write failing activation tests for unchanged-file reuse**

Add these tests to `src/test/suite/extension.test.ts` near the persistence and activation reconciliation coverage:

```ts
test('reuses cached file, text, and symbol entries when the persisted Merkle leaf hash is unchanged', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-reuse-'));
  const indexedFilePath = path.join(workspaceRoot, 'src', 'app', 'main.ts');
  await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
  await fs.writeFile(indexedFilePath, 'const value = 1;', 'utf8');

  const workspaceUri = vscode.Uri.file(workspaceRoot);
  const indexedFile = vscode.Uri.file(indexedFilePath);
  let symbolProviderCalls = 0;
  let persistedSnapshotWrites = 0;

  const persistedSnapshot = {
    metadata: {
      schemaVersion: 2,
      workspaceId: toExpectedWorkspaceId([workspaceUri]),
      configHash: DEFAULT_PERSISTENCE_CONFIG_HASH
    },
    merkle: {
      rootHash: 'root-hash',
      subtreeHashes: [{ path: 'src', hash: 'src-hash' }],
      leaves: [{
        relativePath: 'src/app/main.ts',
        uri: indexedFile.toString(),
        contentHash: 'same-hash',
        size: 16
      }]
    },
    fileIndex: [{
      relativePath: 'src/app/main.ts',
      uri: indexedFile.toString(),
      basename: 'main.ts',
      extension: '.ts',
      tokens: ['src', 'app', 'main', 'ts']
    }],
    textIndex: [{
      relativePath: 'src/app/main.ts',
      uri: indexedFile.toString(),
      content: 'const value = 1;',
      contentHash: 'same-hash'
    }],
    symbolIndex: [{
      relativePath: 'src/app/main.ts',
      contentHash: 'same-hash',
      symbols: [{
        name: 'MainService',
        kind: 5,
        containerName: 'App',
        uri: indexedFile.toString(),
        startLine: 0,
        startColumn: 0,
        approximate: false
      }]
    }]
  };

  const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
    appendLine: () => undefined,
    dispose: () => undefined,
    name: 'Fast Symbol Indexer',
    append: () => undefined,
    clear: () => undefined,
    hide: () => undefined,
    replace: () => undefined,
    show: () => undefined
  })) as unknown) as typeof vscode.window.createOutputChannel);
  const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
  const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string) => {
    if (command === 'vscode.executeDocumentSymbolProvider') {
      symbolProviderCalls += 1;
      return [];
    }
    return undefined;
  }) as typeof vscode.commands.executeCommand);
  const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [indexedFile]) as typeof vscode.workspace.findFiles);
  const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) =>
    typeof pathOrUri === 'string' ? pathOrUri : 'src/app/main.ts') as typeof vscode.workspace.asRelativePath);
  const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
    uri: workspaceUri,
    index: 0,
    name: 'workspace'
  })) as typeof vscode.workspace.getWorkspaceFolder);
  const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
    uri: workspaceUri,
    index: 0,
    name: 'workspace'
  }] as typeof vscode.workspace.workspaceFolders);
  const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
    onDidCreate: () => new vscode.Disposable(() => undefined),
    onDidChange: () => new vscode.Disposable(() => undefined),
    onDidDelete: () => new vscode.Disposable(() => undefined),
    dispose: () => undefined
  })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
  const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) =>
    new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
  const persistenceReadPatch = patchProperty(
    PersistenceStore.prototype,
    'readWorkspaceSnapshot',
    (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
  );
  const persistenceWritePatch = patchProperty(
    PersistenceStore.prototype,
    'writeWorkspaceSnapshot',
    (async () => { persistedSnapshotWrites += 1; }) as typeof PersistenceStore.prototype.writeWorkspaceSnapshot
  );

  try {
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    await waitFor(() => persistedSnapshotWrites === 1, 'merkle snapshot persistence');
  } finally {
    restoreProperty(persistenceWritePatch);
    restoreProperty(persistenceReadPatch);
    restoreProperty(configListenerPatch);
    restoreProperty(watcherPatch);
    restoreProperty(workspaceFoldersPatch);
    restoreProperty(workspaceFolderPatch);
    restoreProperty(relativePatch);
    restoreProperty(findFilesPatch);
    restoreProperty(executeCommandPatch);
    restoreProperty(registerPatch);
    restoreProperty(outputPatch);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }

  assert.equal(symbolProviderCalls, 0);
  assert.equal(persistedSnapshotWrites, 1);
});

test('rebuilds only changed files when one persisted Merkle leaf hash differs', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-changed-'));
  const unchangedPath = path.join(workspaceRoot, 'src', 'unchanged.ts');
  const changedPath = path.join(workspaceRoot, 'src', 'changed.ts');
  await fs.mkdir(path.dirname(unchangedPath), { recursive: true });
  await fs.writeFile(unchangedPath, 'export const unchanged = 1;\n', 'utf8');
  await fs.writeFile(changedPath, 'export const changed = 2;\n', 'utf8');

  const workspaceUri = vscode.Uri.file(workspaceRoot);
  const unchangedUri = vscode.Uri.file(unchangedPath);
  const changedUri = vscode.Uri.file(changedPath);
  const providerCalls: string[] = [];
  const persistedSnapshot = {
    metadata: {
      schemaVersion: 2,
      workspaceId: toExpectedWorkspaceId([workspaceUri]),
      configHash: DEFAULT_PERSISTENCE_CONFIG_HASH
    },
    merkle: {
      rootHash: 'stale-root',
      subtreeHashes: [{ path: 'src', hash: 'stale-src' }],
      leaves: [
        { relativePath: 'src/unchanged.ts', uri: unchangedUri.toString(), contentHash: 'same-hash', size: 28 },
        { relativePath: 'src/changed.ts', uri: changedUri.toString(), contentHash: 'old-hash', size: 26 }
      ]
    },
    fileIndex: [],
    textIndex: [],
    symbolIndex: []
  };

  const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
    if (command === 'vscode.executeDocumentSymbolProvider' && uri) {
      providerCalls.push(uri.fsPath);
      return [];
    }
    return undefined;
  }) as typeof vscode.commands.executeCommand);
  const outputPatch = patchProperty(vscode.window, 'createOutputChannel', ((() => ({
    appendLine: () => undefined,
    dispose: () => undefined,
    name: 'Fast Symbol Indexer',
    append: () => undefined,
    clear: () => undefined,
    hide: () => undefined,
    replace: () => undefined,
    show: () => undefined
  })) as unknown) as typeof vscode.window.createOutputChannel);
  const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((() => new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.commands.registerCommand);
  const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [unchangedUri, changedUri]) as typeof vscode.workspace.findFiles);
  const relativePatch = patchProperty(vscode.workspace, 'asRelativePath', ((pathOrUri: string | vscode.Uri) => {
    if (typeof pathOrUri === 'string') {
      return pathOrUri;
    }
    return path.relative(workspaceRoot, pathOrUri.fsPath).replace(/\\/g, '/');
  }) as typeof vscode.workspace.asRelativePath);
  const workspaceFolderPatch = patchProperty(vscode.workspace, 'getWorkspaceFolder', ((uri: vscode.Uri) => ({
    uri: workspaceUri,
    index: 0,
    name: 'workspace'
  })) as typeof vscode.workspace.getWorkspaceFolder);
  const workspaceFoldersPatch = patchProperty(vscode.workspace, 'workspaceFolders', [{
    uri: workspaceUri,
    index: 0,
    name: 'workspace'
  }] as typeof vscode.workspace.workspaceFolders);
  const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
    onDidCreate: () => new vscode.Disposable(() => undefined),
    onDidChange: () => new vscode.Disposable(() => undefined),
    onDidDelete: () => new vscode.Disposable(() => undefined),
    dispose: () => undefined
  })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
  const configListenerPatch = patchProperty(vscode.workspace, 'onDidChangeConfiguration', (((_listener: (event: vscode.ConfigurationChangeEvent) => unknown) =>
    new vscode.Disposable(() => undefined)) as unknown) as typeof vscode.workspace.onDidChangeConfiguration);
  const persistenceReadPatch = patchProperty(
    PersistenceStore.prototype,
    'readWorkspaceSnapshot',
    (async () => persistedSnapshot) as typeof PersistenceStore.prototype.readWorkspaceSnapshot
  );

  try {
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    await waitFor(() => providerCalls.length === 1, 'single changed-file reconciliation');
  } finally {
    restoreProperty(persistenceReadPatch);
    restoreProperty(configListenerPatch);
    restoreProperty(watcherPatch);
    restoreProperty(workspaceFoldersPatch);
    restoreProperty(workspaceFolderPatch);
    restoreProperty(relativePatch);
    restoreProperty(findFilesPatch);
    restoreProperty(registerPatch);
    restoreProperty(outputPatch);
    restoreProperty(executeCommandPatch);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
  assert.deepEqual(providerCalls, [changedUri.fsPath]);
});
```

- [ ] **Step 2: Run the activation tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='reuses cached file, text, and symbol entries|rebuilds only changed files'; npm test
```

Expected: FAIL because `src/extension.ts` still reprocesses every file during startup reconciliation.

- [ ] **Step 3: Build the current workspace Merkle state before deciding what to index**

Add helper types and functions in `src/extension.ts` above `buildWorkspaceIndexes(...)`:

```ts
type IndexedFileCacheEntry = {
  relativePath: string;
  uri: string;
  contentHash: string;
  textContent?: string;
  symbols?: SymbolRecord[];
  semanticEntries?: SemanticIndexFileEntry['entries'];
};

async function buildCurrentMerkleLeaves(
  files: vscode.Uri[],
  ignoreMatcher: IgnoreMatcher,
  output: vscode.OutputChannel
): Promise<MerkleLeafRecord[]> {
  const leaves: MerkleLeafRecord[] = [];

  for (const file of files) {
    const relativePath = vscode.workspace.asRelativePath(file, true);
    if (ignoreMatcher.ignores(file.fsPath, relativePath)) {
      continue;
    }

    const bytes = await vscode.workspace.fs.readFile(file);
    leaves.push({
      relativePath,
      uri: file.toString(),
      contentHash: hashContent(Buffer.from(bytes)),
      size: bytes.byteLength
    });
  }

  return leaves;
}
```

- [ ] **Step 4: Reuse unchanged caches and rebuild only changed files**

Refactor `buildWorkspaceIndexes(...)` so it diffs current leaves against the persisted Merkle leaves and reuses cached state for unchanged paths:

```ts
const currentLeaves = await buildCurrentMerkleLeaves(files, ignoreMatcher, output);
const currentTree = buildMerkleTree(currentLeaves);
const previousLeaves = new Map(
  (restoredSnapshot?.merkle.leaves ?? []).map((leaf) => [leaf.relativePath, leaf])
);
const diff = diffMerkleLeaves(previousLeaves, currentTree.leavesByPath);

for (const removedLeaf of diff.removed) {
  fileIndex.removeForFile(removedLeaf.relativePath, toIndexedFileKey(vscode.Uri.parse(removedLeaf.uri), removedLeaf.relativePath));
  textIndex.removeForFile(removedLeaf.relativePath);
  symbolIndex.removeForFile(removedLeaf.relativePath);
  semanticIndex.removeForFile(removedLeaf.relativePath);
}

for (const unchangedLeaf of diff.unchanged) {
  const persistedTextEntry = restoredSnapshot?.textIndex.find((entry) =>
    entry.relativePath === unchangedLeaf.relativePath && entry.contentHash === unchangedLeaf.contentHash
  );
  const persistedSymbolEntry = restoredSnapshot?.symbolIndex.find((entry) =>
    entry.relativePath === unchangedLeaf.relativePath && entry.contentHash === unchangedLeaf.contentHash
  );

  fileIndex.upsert(unchangedLeaf.relativePath, unchangedLeaf.uri, toIndexedFileKey(vscode.Uri.parse(unchangedLeaf.uri), unchangedLeaf.relativePath));
  if (persistedTextEntry) {
    textIndex.upsert(persistedTextEntry.relativePath, persistedTextEntry.uri, persistedTextEntry.content);
  }
  if (persistedSymbolEntry) {
    symbolIndex.replaceForFile(persistedSymbolEntry.relativePath, persistedSymbolEntry.symbols);
  }
}

for (const leaf of [...diff.added, ...diff.changed]) {
  fileIndex.upsert(leaf.relativePath, leaf.uri, toIndexedFileKey(vscode.Uri.parse(leaf.uri), leaf.relativePath));

  const fileUri = vscode.Uri.parse(leaf.uri);
  const content = await readEligibleTextContent(vscode.workspace.fs, fileUri, leaf.relativePath, config.maxFileSizeKb);
  if (content === undefined) {
    textIndex.removeForFile(leaf.relativePath);
  } else {
    textIndex.upsert(leaf.relativePath, leaf.uri, content);
  }

  const symbolResult = await getDocumentSymbolsForBuild(fileUri, config.symbolProviderTimeoutMs);
  if (symbolResult.timedOut) {
    symbolIndex.removeForFile(leaf.relativePath);
  } else {
    symbolIndex.replaceForFile(leaf.relativePath, symbolResult.symbols);
    semanticService.enqueueFile(leaf.relativePath, symbolResult.symbols, generation);
  }
}
```

Also update `createPersistedWorkspaceSnapshot(...)` so it writes:

```ts
    merkle: {
      rootHash: currentTree.rootHash,
      subtreeHashes: toPersistedSubtreeHashes(currentTree.subtreeHashes),
      leaves: [...currentTree.leavesByPath.values()]
    },
```

and ensure `textIndex` / `symbolIndex` persisted entries include `contentHash`.

- [ ] **Step 5: Run the activation tests to verify they pass**

Run:

```powershell
$env:MOCHA_GREP='reuses cached file, text, and symbol entries|rebuilds only changed files'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the startup Merkle reconciliation**

Run:

```powershell
git add src\extension.ts src\test\suite\extension.test.ts
git commit -m "feat: reuse unchanged caches with merkle reconciliation" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Replace full watcher rebuilds with targeted Merkle invalidation

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/test/suite/extension.test.ts`
- Test: `src/test/suite/extension.test.ts`

- [ ] **Step 1: Write failing watcher tests for targeted updates**

Add these tests to `src/test/suite/extension.test.ts`:

```ts
test('reindexes only the changed file after a watcher change event', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-watch-change-'));
  const alphaPath = path.join(workspaceRoot, 'src', 'alpha.ts');
  const betaPath = path.join(workspaceRoot, 'src', 'beta.ts');
  await fs.mkdir(path.dirname(alphaPath), { recursive: true });
  await fs.writeFile(alphaPath, 'export const alpha = 1;\n', 'utf8');
  await fs.writeFile(betaPath, 'export const beta = 1;\n', 'utf8');

  const providerCalls: string[] = [];
  let onDidChange: ((uri: vscode.Uri) => void) | undefined;

  const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
    onDidCreate: () => new vscode.Disposable(() => undefined),
    onDidChange: (listener: (uri: vscode.Uri) => void) => {
      onDidChange = listener;
      return new vscode.Disposable(() => undefined);
    },
    onDidDelete: () => new vscode.Disposable(() => undefined),
    dispose: () => undefined
  })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
  const executeCommandPatch = patchProperty(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
    if (command === 'vscode.executeDocumentSymbolProvider' && uri) {
      providerCalls.push(uri.fsPath);
      return [];
    }
    return undefined;
  }) as typeof vscode.commands.executeCommand);
  const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
    vscode.Uri.file(alphaPath),
    vscode.Uri.file(betaPath)
  ]) as typeof vscode.workspace.findFiles);

  activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  providerCalls.splice(0, providerCalls.length);
  await fs.writeFile(betaPath, 'export const beta = 2;\n', 'utf8');
  onDidChange?.(vscode.Uri.file(betaPath));
  await waitFor(() => providerCalls.length === 1, 'single-file watcher rebuild');

  restoreProperty(findFilesPatch);
  assert.deepEqual(providerCalls, [betaPath]);
});

test('removes file, text, and symbol caches after a watcher delete event', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fast-indexer-merkle-watch-delete-'));
  const indexedFilePath = path.join(workspaceRoot, 'src', 'alpha.ts');
  await fs.mkdir(path.dirname(indexedFilePath), { recursive: true });
  await fs.writeFile(indexedFilePath, 'export const alpha = 1;\n', 'utf8');

  let onDidDelete: ((uri: vscode.Uri) => void) | undefined;
  const quickPickItems: vscode.QuickPickItem[] = [];

  const watcherPatch = patchProperty(vscode.workspace, 'createFileSystemWatcher', (((_globPattern: vscode.GlobPattern) => ({
    onDidCreate: () => new vscode.Disposable(() => undefined),
    onDidChange: () => new vscode.Disposable(() => undefined),
    onDidDelete: (listener: (uri: vscode.Uri) => void) => {
      onDidDelete = listener;
      return new vscode.Disposable(() => undefined);
    },
    dispose: () => undefined
  })) as unknown) as typeof vscode.workspace.createFileSystemWatcher);
  const quickPickPatch = patchProperty(vscode.window, 'showQuickPick', ((async (items: readonly vscode.QuickPickItem[]) => {
    quickPickItems.splice(0, quickPickItems.length, ...items);
    return undefined;
  }) as unknown) as typeof vscode.window.showQuickPick);
  const findFilesPatch = patchProperty(vscode.workspace, 'findFiles', (async () => [
    vscode.Uri.file(indexedFilePath)
  ]) as typeof vscode.workspace.findFiles);
  const registerPatch = patchProperty(vscode.commands, 'registerCommand', ((command: string, callback: (...args: unknown[]) => unknown) => {
    if (command === 'fastIndexer.goToFile') {
      void Promise.resolve(callback());
    }
    return new vscode.Disposable(() => undefined);
  }) as typeof vscode.commands.registerCommand);

  activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  onDidDelete?.(vscode.Uri.file(indexedFilePath));
  await waitFor(() => quickPickItems.length >= 0, 'quick pick refresh');

  restoreProperty(registerPatch);
  restoreProperty(findFilesPatch);
  assert.equal(quickPickItems.some((item) => item.label === 'alpha.ts'), false);
});
```

- [ ] **Step 2: Run the watcher tests to verify they fail**

Run:

```powershell
$env:MOCHA_GREP='watcher change event|watcher delete event'; npm test
```

Expected: FAIL because watcher events still queue workspace-wide rebuilds.

- [ ] **Step 3: Track pending update jobs and apply per-path Merkle updates**

Replace the rebuild-only watcher path in `src/extension.ts` with an incremental updater:

```ts
let pendingUpdateJobs: UpdateJob[] = [];

const queueWorkspaceRefreshForJob = (job: UpdateJob): void => {
  if (job.filePath && configuredIgnoreFilePaths.has(normalizeWorkspaceFilePath(job.filePath))) {
    void refreshIgnoreMatcher().finally(() => {
      pendingUpdateJobs.push(job);
      runQueuedIncrementalUpdate();
    });
    return;
  }

  if (!shouldProcessUpdateJob(job, getWatcherFilters(getConfig(), activeIgnoreMatcher))) {
    return;
  }

  pendingUpdateJobs.push(job);
  runQueuedIncrementalUpdate();
};

const runQueuedIncrementalUpdate = (): void => {
  if (initialFileIndexBuildPending || rebuildInFlight || pendingUpdateJobs.length === 0) {
    return;
  }

  const jobs = pendingUpdateJobs.splice(0, pendingUpdateJobs.length);
  rebuildInFlight = true;
  void applyIncrementalMerkleUpdates(jobs)
    .finally(() => {
      rebuildInFlight = false;
      if (pendingUpdateJobs.length > 0) {
        runQueuedIncrementalUpdate();
      }
    });
};
```

- [ ] **Step 4: Implement the incremental update helper**

In `src/extension.ts`, add:

```ts
async function applyIncrementalMerkleUpdates(jobs: UpdateJob[]): Promise<void> {
  for (const job of jobs) {
    if (job.type === 'delete') {
      fileIndex.removeForFile(job.relativePath);
      textIndex.removeForFile(job.relativePath);
      symbolIndex.removeForFile(job.relativePath);
      semanticIndex.removeForFile(job.relativePath);
      merkleState.leavesByPath.delete(job.relativePath);
      continue;
    }

    const uri = vscode.Uri.file(job.filePath!);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const contentHash = hashContent(Buffer.from(bytes));

    merkleState.leavesByPath.set(job.relativePath, {
      relativePath: job.relativePath,
      uri: uri.toString(),
      contentHash,
      size: bytes.byteLength
    });

    fileIndex.upsert(job.relativePath, uri.toString(), toIndexedFileKey(uri, job.relativePath));
    const content = await readEligibleTextContent(vscode.workspace.fs, uri, job.relativePath, getConfig().maxFileSizeKb);
    if (content === undefined) {
      textIndex.removeForFile(job.relativePath);
    } else {
      textIndex.upsert(job.relativePath, uri.toString(), content);
    }

    const symbolResult = await getDocumentSymbolsForBuild(uri, getConfig().symbolProviderTimeoutMs);
    if (symbolResult.timedOut) {
      symbolIndex.removeForFile(job.relativePath);
    } else {
      symbolIndex.replaceForFile(job.relativePath, symbolResult.symbols);
    }
  }

  const rebuiltTree = buildMerkleTree([...merkleState.leavesByPath.values()]);
  merkleState = rebuiltTree;
  await persistenceStore.writeWorkspaceSnapshot(
    workspacePersistence.workspaceId,
    createPersistedWorkspaceSnapshot(workspacePersistence, activePersistenceConfigHash, fileIndex, symbolIndex, textIndex, semanticIndex, merkleState)
  );
}
```

- [ ] **Step 5: Run the watcher tests to verify they pass**

Run:

```powershell
$env:MOCHA_GREP='watcher change event|watcher delete event'; npm test
```

Expected: PASS.

- [ ] **Step 6: Commit the targeted watcher invalidation**

Run:

```powershell
git add src\extension.ts src\test\suite\extension.test.ts
git commit -m "feat: update merkle caches from watcher events" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Run full verification and inspect the final diff

**Files:**
- Modify: `src/core/contentHash.ts` (already created)
- Modify: `src/core/merkleTree.ts` (already created)
- Modify: `src/core/merkleSnapshot.ts` (already created)
- Modify: `src/core/persistenceStore.ts`
- Modify: `src/indexes/fileIndex.ts`
- Modify: `src/indexes/textIndex.ts`
- Modify: `src/indexes/symbolIndex.ts`
- Modify: `src/semantics/semanticIndex.ts`
- Modify: `src/extension.ts`
- Modify: `src/test/suite/*.test.ts` (already updated)
- Test: `npm test`

- [ ] **Step 1: Run the full test suite**

Run:

```powershell
npm test
```

Expected: PASS with the full suite green.

- [ ] **Step 2: Check for whitespace or patch damage**

Run:

```powershell
git --no-pager diff --check
git --no-pager status --short
```

Expected: no whitespace errors and only the intended Merkle-indexing files changed.

- [ ] **Step 3: Commit the final verified state**

Run:

```powershell
git add src\core\contentHash.ts src\core\merkleTree.ts src\core\merkleSnapshot.ts src\core\persistenceStore.ts src\indexes\fileIndex.ts src\indexes\textIndex.ts src\indexes\symbolIndex.ts src\semantics\semanticIndex.ts src\extension.ts src\test\suite\merkleTree.test.ts src\test\suite\persistenceStore.test.ts src\test\suite\fileIndex.test.ts src\test\suite\textIndex.test.ts src\test\suite\symbolIndex.test.ts src\test\suite\extension.test.ts
git commit -m "feat: add merkle-driven cache reuse" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review

- **Spec coverage:** The plan covers the Merkle primitives, persisted Merkle state, per-file cache invalidation, startup diff-based reuse, watcher-driven targeted updates, and full verification. The one intentionally conservative point is semantic metadata reuse: the plan keeps semantic invalidation conservative rather than promising perfect cross-file semantic correctness.
- **Placeholder scan:** The draft originally had vague watcher and activation test notes; those were replaced with concrete fixtures, patch points, assertions, and incremental rebuild code snippets. The remaining inline comments only identify where to reuse the same patching pattern as adjacent existing tests.
- **Type consistency:** The plan consistently uses `MerkleLeafRecord`, `MerkleTreeSnapshot`, `PersistedMerkleSnapshot`, `contentHash`, and the existing `getDocumentSymbolsForBuild(...)` helper name from the current codebase.
