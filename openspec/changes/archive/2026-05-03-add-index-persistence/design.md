## Context

The extension already has a mature in-memory indexing pipeline for files, text, and symbols, plus watcher-driven updates and explicit rebuild behavior. It also has the start of a persistence abstraction, but that abstraction currently only supports cache clearing and does not restore or save any usable snapshot state.

The product stance for persistence is now intentionally narrow: persistence is an internal cache, not a supported user-facing feature with settings or guarantees. That gives the implementation room to improve startup performance and warm-start behavior without yet committing to long-term compatibility promises in the public configuration surface.

The design therefore needs to make persistence reliable enough to be useful while keeping it explicitly subordinate to correctness. Missing, stale, invalid, or incompatible cache state must degrade cleanly to the existing rebuild path.

## Goals / Non-Goals

**Goals:**
- Restore cached file, text, and symbol index snapshots during activation when they are valid for the current workspace composition.
- Persist fresh snapshots after successful full indexing or rebuild completion.
- Define cache validity in terms of workspace identity, relevant indexing configuration, and persistence schema version.
- Treat stale, incompatible, or corrupt cache state as a normal fallback-to-rebuild path.
- Keep persistence internal-only with no new user-facing persistence settings in this change.

**Non-Goals:**
- Adding user-facing persistence controls or guarantees.
- Persisting every incremental watcher update with perfect immediacy.
- Synchronizing caches across machines, workspaces, or users.
- Treating persisted state as semantically stronger than live provider-backed results.

## Decisions

### 1. Use snapshot-based persistence before delta persistence

The first persistence step should serialize and restore complete snapshots for `FileIndex`, `TextIndex`, and `SymbolIndex` rather than attempting per-event delta journaling immediately.

This keeps the initial design easy to reason about:
- activation can load one snapshot bundle,
- successful builds can write one coherent snapshot bundle,
- and invalidation can discard the whole snapshot when identity or schema no longer matches.

**Alternatives considered:**
- **Persist every watcher delta immediately:** rejected for the first persistence change because it adds ordering, corruption, and partial-write complexity too early.
- **Persist only one index type first:** rejected because warm-start behavior is most useful when the three base indexes recover together.

### 2. Treat restored state as a warm start, not final truth

Restored snapshots should make commands useful sooner, but the extension should still reconcile in the background against the current workspace state.

That means the lifecycle becomes:

```text
activation
  -> attempt snapshot restore
  -> if valid, hydrate indexes
  -> mark state usable/warm
  -> start background reconciliation
  -> persist a fresh snapshot after successful completion
```

This avoids treating cache state as authoritative while still capturing the startup performance benefit.

**Alternatives considered:**
- **Skip background reconciliation after restore:** rejected because cache correctness would depend too heavily on perfect invalidation.
- **Ignore restore and only write snapshots:** rejected because it pays persistence complexity without delivering the startup benefit.

### 3. Define cache validity from full workspace composition plus config and schema metadata

Cache reuse should depend on metadata that answers: “Is this snapshot still for the same effective workspace and indexing contract?”

The snapshot metadata should include at least:
- persistence schema version,
- extension or cache format version,
- workspace identity derived from the full current workspace composition,
- and a hash or comparable summary of relevant indexing configuration.

**Alternatives considered:**
- **Use first workspace folder only:** rejected because the base capability now defines workspace identity as the full current workspace composition.
- **Reuse cache across config changes:** rejected because include/exclude/size settings directly affect snapshot validity.

### 4. Fail closed on cache problems

Missing, corrupt, or incompatible persistence data should never block activation and should never be surfaced as a fatal user error. The system should discard the bad cache and continue with the existing rebuild path.

**Alternatives considered:**
- **Try partial recovery from corrupt caches:** rejected for the first change because it complicates validation and can leak stale state.
- **Show user-facing persistence errors by default:** rejected because persistence is still internal-only.

## Risks / Trade-offs

- **Cache snapshots can be large** -> Mitigation: start with simple structured snapshots, then optimize layout only if size or write time becomes a proven issue.
- **Workspace identity can still drift from implementation reality** -> Mitigation: define the metadata contract explicitly and add validation around workspace-composition changes.
- **Warm-start results may briefly reflect stale local state before reconciliation** -> Mitigation: keep reconciliation automatic and prefer correctness over cache reuse when validity is uncertain.
- **Persistence complexity can quietly become a user-facing contract** -> Mitigation: keep settings out of scope and document persistence as internal-only in the change artifacts.

## Migration Plan

1. Introduce snapshot read/write primitives and metadata validation in `PersistenceStore`.
2. Attempt restore during activation before starting background reconciliation.
3. Persist fresh snapshots after successful full indexing or rebuild completion.
4. Invalidate snapshots on schema, config, or workspace-identity mismatch.
5. Roll back safely by disabling restore/write calls while leaving the in-memory index lifecycle intact.

## Open Questions

- Should successful warm-start restore map to a distinct coordinator state, or should it remain indistinguishable from other usable partial states?
- Should snapshot persistence happen only after full builds at first, or also after explicit rebuilds if they finish successfully before watcher reconciliation settles?
