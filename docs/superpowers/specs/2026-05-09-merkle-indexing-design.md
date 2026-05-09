# File-Level Merkle Indexing Design

## Problem

FastSearch currently treats indexing as a flat workspace rebuild. Activation restores a persisted snapshot, but the next build still walks the full workspace, re-reads files, and re-derives file, text, and symbol state even when most files have not changed.

That makes large workspaces slower to reconcile than they need to be and gives the extension no durable structure for saying "these files are unchanged, so their cached derived data is still valid."

## Goals

- Detect unchanged files cheaply across startup and rebuilds.
- Reuse cached file, text, and document-symbol results when file content is unchanged.
- Preserve the current command UX and provider-first behavior.
- Keep the design local-only and privacy-preserving.
- Support targeted watcher-driven updates instead of rebuild-on-any-change behavior.
- Keep the design compatible with multi-root workspaces, ignore rules, and persisted snapshots.

## Non-Goals

- Remote sync, server-side hash exchange, or vector-database retrieval.
- Chunk embeddings or Cursor-style semantic recall.
- Replacing the current file/text/symbol command model.
- Solving all cross-file semantic invalidation in the first milestone.

## Recommended Approach

Add a new file-level Merkle layer that becomes the source of truth for change detection, while the existing indexes remain the source of truth for search results.

The Merkle tree should be built over normalized file contents. Each file leaf stores a stable content hash and lightweight file identity data. Directory and workspace nodes store hashes derived from sorted child hashes. On startup or rebuild, FastSearch computes the current tree, diffs it against the persisted tree, and only re-runs indexing work for changed, added, removed, or renamed files.

This keeps the existing `FileIndex`, `TextIndex`, `SymbolIndex`, and `SemanticIndex` valuable. They remain derived caches and search surfaces, while the new Merkle layer answers only one question: which files must be recomputed?

## Core Model

### Source of Truth vs Derived Caches

File content should be the invalidation source of truth.

The relationship is:

`file bytes -> content hash -> derived caches`

That means:

- if a file hash is unchanged, its file/text/document-symbol cache can be reused
- if a file hash changes, those caches must be invalidated and rebuilt for that file
- if a file is removed, its caches must be removed
- if a file is renamed, path-based records must be moved or rebuilt even if content stays the same

This design does **not** need a separate Merkle tree of symbols in the first version. Document symbols are derived from file content, so the file leaf invalidates the symbol cache naturally.

### Semantic Metadata

Basic document symbols are safe to treat as per-file derived data. Semantic enrichment is weaker as a pure file cache because references and implementations can change when other files change.

For the first milestone:

- file, text, and document-symbol caches should be reused when the source file hash is unchanged
- semantic metadata should either be invalidated more conservatively or treated as best-effort cached data that may be refreshed after rebuild

The Merkle design should not depend on perfect semantic invalidation to deliver value.

## Architecture

### New Merkle Components

Add a focused Merkle subsystem instead of folding hashing into the existing flat indexes.

Suggested new modules:

- `src/core/merkleTree.ts`: leaf/node models, root computation, diffing
- `src/core/contentHash.ts`: stable file hashing helpers
- `src/core/merkleSnapshot.ts`: persisted serialization helpers and compatibility checks

The existing index classes should stay narrow:

- `FileIndex` remains a searchable file metadata cache
- `TextIndex` remains a searchable text-content cache
- `SymbolIndex` remains a searchable symbol cache
- `SemanticIndex` remains a companion metadata cache

### Persisted Snapshot Shape

Extend the persisted workspace snapshot rather than writing a completely separate store.

Add a new persisted Merkle section alongside the current file/text/symbol/semantic arrays. At minimum it should contain:

- leaf records by relative path
- each leaf's content hash
- subtree hashes for workspace folders
- workspace root hash
- enough path/identity data to detect adds, deletes, and renames

Each derived per-file cache entry should also carry the content hash it was built from, either directly in the cache entry or in an adjacent per-file cache manifest.

That lets restore logic answer:

- do we have cached file/text/symbol data for this relative path?
- was that cache derived from the current content hash?
- if yes, can we reuse it without recomputing?

### Coordinator Integration

`IndexCoordinator` should keep its current lifecycle role (`warming`, `ready`, `stale`, `rebuilding`), but the underlying build pipeline should change from full recomputation to Merkle-driven reconciliation.

The Merkle layer should be invoked inside the workspace build path in `src/extension.ts`, not as a separate background subsystem with its own lifecycle.

## Data Flow

### Startup / Initial Reconciliation

1. Restore the persisted snapshot, including Merkle state and derived caches.
2. Load ignore rules and config as today.
3. Discover candidate workspace files.
4. Compute current file hashes and rebuild the Merkle tree.
5. Diff the current tree against the persisted tree.
6. Partition files into:
   - unchanged
   - changed
   - added
   - removed
   - renamed if detectable from content hash plus path change
7. Reuse cached file/text/symbol data for unchanged files.
8. Recompute file/text/symbol data only for changed and added files.
9. Remove cached entries for removed files.
10. Persist the updated Merkle tree and derived caches together.

### Watcher-Driven Updates

Watcher events should stop meaning "schedule a full rebuild."

Instead:

1. Normalize the changed path through the current include/exclude/ignore filters.
2. For a changed or created file, read and hash the file, update the leaf, and recompute ancestor hashes.
3. Invalidate and rebuild that file's derived caches.
4. For a deleted file, remove the leaf and remove its derived caches.
5. For rename events, remove the old path, add the new path, and preserve cache reuse only if the content hash proves the file is the same logical leaf.
6. Persist the updated Merkle state and affected caches after the incremental update completes.

The first implementation can still batch multiple watcher events behind the existing debounce, but the work performed after the debounce should be path-targeted rather than workspace-wide.

## Cache Relationships

### File Cache

`FileIndex` entries are cheap and path-oriented. They should still be invalidated when content changes because the same reconciliation step is already touching that file, but they mainly exist to support search, not correctness-sensitive semantic state.

### Text Cache

`TextIndex` content is a direct derivative of the file bytes. If the content hash is unchanged, the cached text entry is valid. If the content hash changes, the text cache must be replaced.

### Symbol Cache

`SymbolIndex` should be treated the same way as `TextIndex`, but with provider-derived content:

- unchanged file hash => reuse cached document symbols
- changed file hash => rerun `getDocumentSymbolsForBuild(...)` and replace the file's symbols

This is the main relationship between symbol caching and file caching: the file hash invalidates the symbol cache.

### Semantic Cache

`SemanticIndex` should initially be more conservative:

- invalidate when the owning file changes
- allow reuse for unchanged files only as a performance optimization, not as a strong correctness guarantee
- keep provider-first command-time behavior unchanged so stale semantic cache never becomes authoritative

## Hashing and Identity Rules

Use normalized file bytes as the leaf hash input. Directory hashes should be derived from sorted child `(name, hash)` pairs so tree shape is deterministic.

Important invariants:

- identical file contents produce identical leaf hashes
- identical directory contents produce identical subtree hashes regardless of traversal order
- path normalization stays Windows-aware and matches the repo's existing `\\` to `/` conventions
- config and ignore inputs still participate in snapshot compatibility outside the Merkle tree itself

The persisted config hash should remain separate from the Merkle root. File hashes answer "did content change?"; config hash answers "is the cached interpretation of content still valid?"

## Error Handling

- Hashing failures should be explicit and non-fatal; they should log diagnostics and treat the affected file as needing rebuild or removal.
- Missing files during incremental updates should be treated as deletes.
- Slow or failing document-symbol providers should continue using the current timeout behavior and output-channel diagnostics.
- Corrupt or incompatible persisted Merkle state should invalidate the snapshot and fall back to a normal rebuild.

The system should never silently reuse a derived cache when the corresponding content hash is missing or mismatched.

## Migration and Rollout

Deliver this in stages.

### Milestone 1

Persist file content hashes and a workspace Merkle root. Diff startup state and skip re-indexing unchanged files during activation-time reconciliation.

### Milestone 2

Add subtree hashes and incremental watcher updates so single-file changes update only the affected leaf, ancestors, and per-file caches.

### Milestone 3

Refine rename detection, semantic-cache policy, and performance optimizations such as stat-based short-circuiting before full file reads.

## Testing Strategy

### Correctness

- stable leaf and subtree hashing
- deterministic root hashes regardless of traversal order
- startup diff correctly classifies unchanged/changed/added/removed files
- unchanged files reuse cached text and symbol entries
- changed files rebuild text and symbol entries
- deletes remove caches
- renames update path-based records correctly
- config-hash incompatibility still invalidates persisted state even if file hashes match

### Responsiveness

- large workspace startup reuses unchanged caches instead of re-reading and re-indexing every file
- watcher updates touch only the affected file set
- symbol-provider timeout behavior remains bounded during Merkle-triggered rebuilds
- progress reporting still reflects discovery and changed-file processing accurately

## Delivery Notes

The first implementation should stay intentionally narrow: add file-level Merkle invalidation and cache reuse without redesigning command behavior or inventing chunk-level semantics.

If this works well, it becomes the foundation for deeper caching later. If it does not, the extension still keeps its current search architecture because the Merkle layer is isolated to change detection and rebuild planning.
