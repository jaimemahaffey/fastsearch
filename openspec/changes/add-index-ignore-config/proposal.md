## Why

The extension currently supports only direct glob exclusions plus a small set of hardcoded heavy paths, which makes it awkward to share ignore intent and to express familiar `.gitignore`-style path rules. This change adds a configurable ignore-file system now so indexing and watcher behavior can respect richer, reusable ignore definitions without removing the existing settings workflow.

## What Changes

- Add configuration for one or more ignore-file path entries that use `.gitignore`-style rule semantics.
- Keep `fastIndexer.exclude` as an explicit glob-based setting and merge it with ignore-file rules and built-in heavy-path exclusions.
- Apply the merged ignore matcher consistently to initial indexing, watcher filtering, and rebuild invalidation behavior.
- Support both per-workspace-folder and shared workspace-level ignore-file path resolution in multi-root workspaces.
- Invalidate warm-start persistence when effective ignore configuration changes so cached indexes are not reused with stale ignore rules.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `fast-workspace-indexing`: workspace indexing requirements expand to support configurable ignore-file inputs, merged ignore matching, and ignore-driven invalidation behavior.

## Impact

- Affected code: configuration loading, workspace watcher filtering, file/text eligibility checks, extension activation/rebuild wiring, persistence validation, and indexing tests.
- Affected APIs: VS Code configuration surface for `fastIndexer.*` settings.
- Affected systems: initial workspace discovery, incremental update filtering, multi-root workspace handling, and persisted index reuse.
