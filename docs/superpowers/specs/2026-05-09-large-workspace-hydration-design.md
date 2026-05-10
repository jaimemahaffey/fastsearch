# Large Workspace Hydration Design

## Problem

FastSearch now reaches file and text readiness much earlier than before, but QMK-scale benchmarking shows the remaining long tail is dominated by eager provider-backed symbol indexing. In a normal VS Code environment, `findFiles` over 22,333 files took about 2.6 seconds, the file layer became available around 8.4 seconds, and the text layer became available around 30.1 seconds. The symbol phase then attempted only about 1,818 of 22,333 provider symbol requests after roughly 225 additional seconds, projecting full completion around 45-50 minutes.

The current startup pipeline still treats provider-backed full-workspace symbols as part of build completion. That preserves complete local symbol coverage, but it makes large repositories look permanently "still indexing" even after file and text search are already useful.

## Goals

- Keep file search and text search usable quickly on large workspaces.
- Preserve provider-first command behavior for usages and implementations.
- Preserve full provider-backed symbol functionality eventually, but remove full-workspace symbol hydration from the startup critical path.
- Keep approximate and partial local results explicitly labeled.
- Use Merkle content hashes as the invalidation source of truth for file, text, symbol, and semantic caches.
- Persist partial symbol progress so long hydration work is not thrown away between sessions.
- Keep the extension host responsive while background hydration continues.

## Non-Goals

- Replace VS Code language providers with a custom parser for every language.
- Remove provider-backed symbol quality.
- Make approximate or partial results look authoritative.
- Add remote indexing, external services, or any non-local code processing.
- Solve cross-file semantic invalidation perfectly in this milestone.

## Recommended Approach

Use deferred, budgeted symbol hydration with batch-wise text readiness.

The startup path should complete once the file and text layers are usable and symbol fallback data is at least partially usable from restored or freshly hydrated entries. Provider-backed symbol hydration should move into a background scheduler that uses explicit budgets and priority ordering. Full symbol coverage remains a target state, but it is no longer required before the initial build can stop blocking commands.

## Architecture

### 1. Discovery and File Layer

The existing discovery path remains the entry point. It should continue to use VS Code `findFiles`, the built-in heavy-path exclusions, `fastIndexer.exclude`, and configured ignore files. After candidates are normalized and filtered, `FileIndex` can be populated from path metadata and the `file` layer can be marked available.

### 2. Merkle and Text Hydration

The current Merkle/content-read pass reads all candidate files before the text layer becomes available. That should be reshaped into a batch-producing pipeline:

1. Read a batch of candidates.
2. Build `WorkspaceMerkleEntry` records for the batch.
3. Immediately update `TextIndex` entries for files with eligible text content.
4. Continue until all batches are complete.
5. Build the final Merkle tree and persist the complete checkpoint.

The text layer may be marked usable before full completion when one of these conditions is met:

- a compatible restored text snapshot exists
- at least one configured batch has completed
- all changed files known from the restored Merkle diff have completed

This preserves correctness because command-time text search can search the data that is currently present while progress reporting continues to show that hydration is still running.

### 3. Symbol Hydration Scheduler

Add a focused scheduler under `src/core/symbolHydrationScheduler.ts`. It should own only queueing, prioritization, cancellation, budget enforcement, and progress state. It should not know how to call VS Code providers directly; instead, it receives a worker callback that reuses the existing `refreshWorkspaceSymbolsOnly(...)` path.

The scheduler queue should prioritize:

1. active editor and open editors
2. changed and added files from Merkle reconciliation
3. recently searched or recently opened paths when available
4. breadth-first directory coverage
5. remaining files

The scheduler should process work under explicit limits:

- startup symbol budget: 10 seconds
- background batch size: 100 files
- default provider concurrency: 1 until provider safety is proven
- checkpoint cadence: after each batch or after 5 seconds of completed symbol work

The default concurrency intentionally stays conservative. The benchmark showed aggregate provider latency, not widespread timeout failures, so raising concurrency is a tuning step after the scheduler exists rather than the core fix.

### 4. Symbol Readiness Semantics

Keep `IndexLayer` compatibility, but separate "symbol usable" from "symbol complete".

- `symbol` layer available means local symbol search has usable data, either restored from a compatible snapshot or produced by at least one current hydration batch.
- A new internal hydration state tracks completeness: `idle`, `running`, `complete`, or `paused`.
- Persist per-file symbol hydration status with the content hash used to produce that symbol data.

This lets `goToSymbol` run quickly with partial/restored data while the status bar can still say background symbol hydration is running.

### 5. Command Behavior

- `goToFile` waits only for `file`.
- `goToText` waits for text usability, not full Merkle completion.
- `goToSymbol` waits for symbol usability, not full symbol completion.
- `cycleSearchMode` should not force full symbol hydration just to switch modes.
- `findUsages` and `findImplementations` keep the existing provider-first contract. If provider-backed results are unavailable and fallback is enabled, fallback readiness should wait only for the local layer it needs.

When local symbol results are partial, quick-pick detail should make that explicit, for example: `Partial symbol index; background hydration is still running`.

### 6. Persistence

Persist symbol hydration metadata alongside existing snapshot metadata. Each symbol entry should remain tied to the file content hash that produced it.

A symbol entry is reusable only when:

- snapshot schema and config hash are compatible
- relative path matches
- content hash matches
- the symbol entry was marked hydrated for that content hash

Partial symbol snapshots are valid. A workspace-level `symbolHydration` metadata record should distinguish partial coverage from complete coverage.

### 7. Error Handling

- Provider timeout for one file records that file as timed out and moves on.
- Provider exceptions log the file path and mark only that file failed.
- Queue items include generation and content hash; stale work is skipped if a rebuild or file change supersedes it.
- Corrupt persisted hydration metadata invalidates only symbol hydration metadata when possible, not the entire file/text snapshot.
- Background hydration failure does not roll back file or text readiness.

## Testing Strategy

### Planner and Scheduler

- changed files outrank unchanged background files
- open files outrank changed files
- breadth-first ordering spreads coverage across directories
- reused complete symbol entries are not requeued
- stale generation and stale content-hash work is skipped
- scheduler cancellation stops new work without corrupting completed entries

### Activation and Commands

- activation reaches file and text readiness without waiting for full symbol hydration
- restored symbols are searchable immediately
- `goToSymbol` can run with partial symbols and labels partial results
- `findUsages` and `findImplementations` remain provider-first
- fallback commands no longer wait on full current build when only partial fallback data is needed

### Persistence

- partial symbol hydration metadata serializes and restores
- unchanged complete symbol entries are reused
- changed file hashes requeue symbol hydration
- failed and timed-out files do not block snapshot restore

### Benchmarking

Add a reusable env-gated benchmark path that reports:

- discovery duration
- file usable time
- text usable time
- symbol usable time
- symbol complete time
- symbol queue counts by status
- provider timeout and failure counts

This benchmark path should be committed as a controlled diagnostic feature, not as temporary ad hoc instrumentation.

## Rollout

1. Add symbol hydration queue planning and scheduler primitives.
2. Persist and restore partial symbol hydration state.
3. Decouple initial build completion from full symbol hydration.
4. Update command gating and partial-result messaging.
5. Refactor Merkle/text hydration into batches.
6. Add reusable benchmark reporting and tune budgets against QMK.
