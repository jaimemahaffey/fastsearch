## 1. Configuration surface

- [x] 1.1 Add settings for configured ignore-file path entries and document their per-folder vs shared-workspace semantics
- [x] 1.2 Extend configuration parsing and rebuild-trigger detection to include ignore-file configuration changes

## 2. Ignore rule loading

- [x] 2.1 Implement ignore-file path resolution for both per-workspace-folder and shared workspace-level entries
- [x] 2.2 Add `.gitignore`-style ignore-file parsing and normalize loaded rules into a matcher-friendly format
- [x] 2.3 Merge built-in heavy-path exclusions, `fastIndexer.exclude`, and loaded ignore-file rules into one effective ignore matcher

## 3. Indexing and watcher integration

- [x] 3.1 Apply the merged ignore matcher to initial workspace discovery and path eligibility checks
- [x] 3.2 Apply the merged ignore matcher to watcher update filtering and ignore-file-triggered refresh behavior
- [x] 3.3 Keep missing, unreadable, or invalid ignore files non-fatal while surfacing diagnostic output

## 4. Persistence and validation

- [x] 4.1 Include effective ignore configuration in persistence validation metadata
- [x] 4.2 Invalidate persisted snapshots and rebuild state when ignore configuration or configured ignore-file inputs change
- [x] 4.3 Add tests for merged ignore matching, multi-root path resolution, watcher filtering, and persistence invalidation
