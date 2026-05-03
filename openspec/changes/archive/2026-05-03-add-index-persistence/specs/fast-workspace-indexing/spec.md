## ADDED Requirements

### Requirement: Internal index snapshot persistence
The system SHALL support internal snapshot persistence for the file, text, and symbol indexes so activation can restore a usable warm-start state without making persistence a user-facing configurable feature.

#### Scenario: Activation restores a valid snapshot
- **WHEN** the extension activates and a valid persisted snapshot exists for the current workspace identity, persistence schema version, and relevant indexing configuration
- **THEN** the system restores cached file, text, and symbol index state before background reconciliation completes
- **AND** commands may use that restored state as a warm-start local result source

#### Scenario: Successful indexing persists a fresh snapshot
- **WHEN** an initial full index build or explicit rebuild completes successfully
- **THEN** the system writes a fresh persisted snapshot for the current workspace identity
- **AND** the snapshot includes metadata sufficient to validate future reuse

#### Scenario: Snapshot validation fails
- **WHEN** persisted snapshot state is missing, stale, corrupt, or incompatible with the current workspace identity, persistence schema version, or relevant indexing configuration
- **THEN** the system discards the invalid snapshot state
- **AND** continues with the normal rebuild path without treating the cache failure as a fatal user-facing error
