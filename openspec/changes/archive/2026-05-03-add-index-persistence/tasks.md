## 1. Persistence primitives

- [x] 1.1 Expand `PersistenceStore` to read, write, and clear structured snapshot bundles for file, text, and symbol indexes.
- [x] 1.2 Define snapshot metadata for persistence schema version, workspace identity, and relevant indexing configuration validity.

## 2. Activation and rebuild lifecycle

- [x] 2.1 Attempt snapshot restore during activation before background reconciliation begins.
- [x] 2.2 Persist a fresh snapshot after successful initial builds and explicit rebuild completion.
- [x] 2.3 Fall back cleanly to the normal rebuild path when snapshot state is missing, stale, corrupt, or incompatible.

## 3. Workspace identity and invalidation

- [x] 3.1 Replace first-folder persistence identity with identity derived from the full current workspace composition.
- [x] 3.2 Invalidate persisted snapshots when workspace composition or relevant indexing configuration changes.

## 4. Validation

- [x] 4.1 Add tests for successful snapshot restore and warm-start command usability.
- [x] 4.2 Add tests for snapshot persistence after successful builds and rebuilds.
- [x] 4.3 Add tests for invalid snapshot fallback, configuration mismatch invalidation, and multi-root workspace identity handling.
