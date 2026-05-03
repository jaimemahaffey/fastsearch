## Why

The fast indexer currently rebuilds its in-memory indexes on every activation even though the architecture already includes the beginnings of a persistence layer. That keeps the product stance simple, but it leaves startup performance and warm-start responsiveness on the table now that the base indexing flows are stable.

This change adds a reliable internal persistence subsystem so the extension can restore cached index snapshots on activation, persist successful rebuilds, and invalidate stale cache state safely without yet turning persistence into a user-facing configurable feature.

## What Changes

- Add internal snapshot persistence for file, text, and symbol indexes after successful builds.
- Restore cached snapshots during activation so commands can start from a warm local state while background reconciliation continues.
- Define robust cache identity and invalidation rules based on full workspace composition, relevant configuration, and persistence schema versioning.
- Treat missing, stale, or corrupt cache state as a normal degraded path that falls back cleanly to rebuild behavior.
- Keep persistence internal-only: no new user-facing persistence settings or guarantees in this change.

## Capabilities

### New Capabilities

### Modified Capabilities
- `fast-workspace-indexing`: extend the base indexing lifecycle to support internal snapshot restore, persistence writes, cache invalidation, and warm-start behavior

## Impact

- Affected code: `src/extension.ts`, `src/core/persistenceStore.ts`, index serialization/hydration paths, workspace identity derivation, and activation/rebuild lifecycle tests.
- Affected systems: extension activation, rebuild flow, cache invalidation logic, and multi-root workspace identity handling.
- Dependencies: no new external service dependency; likely introduces on-disk snapshot formats and version metadata under the extension storage location.
