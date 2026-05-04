## ADDED Requirements

### Requirement: Configurable ignore rule sources
The extension SHALL support configurable ignore rule sources that merge built-in heavy-path exclusions, explicit `fastIndexer.exclude` glob settings, and `.gitignore`-style rules loaded from configured ignore files.

#### Scenario: Initial indexing uses merged ignore rules
- **WHEN** workspace indexing starts
- **THEN** the extension applies the merged ignore matcher before indexing files and directories
- **AND** ignored paths are excluded consistently from file, text, and symbol indexing

#### Scenario: Multi-root ignore-file paths resolve for both shared and per-folder forms
- **WHEN** a multi-root workspace configures ignore-file paths
- **THEN** the extension resolves both workspace-level shared paths and per-workspace-folder paths into the effective ignore matcher
- **AND** matching behavior is evaluated against the current workspace composition

#### Scenario: Missing ignore files do not stop indexing
- **WHEN** a configured ignore file is missing, unreadable, or cannot be parsed
- **THEN** the extension continues indexing with the remaining ignore rule sources
- **AND** does not treat the ignore-file failure as a fatal user-facing error

### Requirement: Ignore changes invalidate index state
The extension SHALL rebuild or invalidate derived index state when effective ignore behavior changes.

#### Scenario: Ignore configuration changes trigger rebuild
- **WHEN** the configured ignore settings change
- **THEN** the extension marks current index state stale
- **AND** rebuilds indexing state against the updated ignore rules

#### Scenario: Ignore-file changes affect watcher filtering
- **WHEN** a configured ignore file changes and indexing remains enabled
- **THEN** the extension refreshes the effective ignore matcher
- **AND** subsequent watcher updates are filtered using the new ignore behavior

#### Scenario: Persistence is invalidated by ignore changes
- **WHEN** persisted snapshot metadata was created with different effective ignore inputs than the current workspace
- **THEN** the extension discards the stale persisted snapshot
- **AND** rebuilds using the current ignore configuration instead of reusing cached index data
