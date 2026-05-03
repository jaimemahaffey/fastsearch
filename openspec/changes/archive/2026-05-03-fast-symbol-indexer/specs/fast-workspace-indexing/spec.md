# fast-workspace-indexing Specification

## ADDED Requirements

### Requirement: Extension activation

The extension SHALL activate without performing heavy synchronous indexing work on the extension host.

#### Scenario: Workspace opens with indexing enabled

- **WHEN** a workspace is opened and `fastIndexer.enabled` is true
- **THEN** the extension registers all contributed commands
- **AND** starts workspace indexing in the background
- **AND** VS Code remains responsive during activation

#### Scenario: Command is invoked before indexing completes

- **WHEN** a `fastIndexer.*` command is invoked while the index is warming
- **THEN** the command opens promptly
- **AND** presents partial results, a progress state, or a clear message that results are still being indexed

### Requirement: Workspace indexing lifecycle

The extension SHALL maintain a local workspace index that can be built initially, updated incrementally, cancelled, and rebuilt explicitly.

#### Scenario: Initial workspace indexing

- **WHEN** indexing starts for a workspace
- **THEN** eligible files are discovered according to configured include and exclude rules
- **AND** file, text, and symbol indexes are populated in bounded background batches
- **AND** failures for individual files do not stop the overall indexing operation

#### Scenario: Incremental file update

- **WHEN** an indexed file is created, modified, renamed, deleted, saved, or changed while open
- **THEN** the affected file entries are added, updated, moved, or removed from the relevant indexes
- **AND** rapid event bursts are debounced or coalesced

#### Scenario: Workspace composition changes

- **WHEN** the set of workspace folders changes in a multi-root workspace
- **THEN** the extension SHALL treat the resulting full workspace composition as the current workspace identity for lifecycle purposes
- **AND** mark stale index state for rebuild against the current composition

#### Scenario: Rebuild supersedes active indexing

- **WHEN** `fastIndexer.rebuildIndex` is invoked while indexing is already running
- **THEN** the active indexing operation is cancelled
- **AND** local index state is cleared
- **AND** a new index build starts for the current workspace

### Requirement: File index

The extension SHALL maintain a file index for fast workspace file navigation.

#### Scenario: Eligible workspace files are indexed

- **WHEN** a file is not excluded and does not exceed configured limits
- **THEN** the file index stores its URI, workspace-relative path, basename, extension, workspace folder, and sortable matching tokens

#### Scenario: Go to file navigation

- **WHEN** `fastIndexer.goToFile` is invoked
- **THEN** the extension shows a quick pick of file matches from the file index
- **AND** selecting a result opens the file in the editor

### Requirement: Text index

The extension SHALL maintain a text index for fast local text discovery.

#### Scenario: Eligible text content is indexed

- **WHEN** a file is detected as text and satisfies configured size and path rules
- **THEN** the text index stores searchable content or tokens sufficient to find text matches
- **AND** binary files and oversized files are skipped

#### Scenario: Go to text navigation

- **WHEN** `fastIndexer.goToText` is invoked with a search query
- **THEN** the extension searches the text index
- **AND** shows quick-pick results with file path, match preview, and location
- **AND** selecting a result opens the file at the matched range

### Requirement: Symbol index

The extension SHALL maintain a symbol index for fast symbol navigation.

#### Scenario: Symbols are provided by VS Code

- **WHEN** a document symbol provider returns symbols for an eligible file
- **THEN** the symbol index stores symbol name, kind, container, URI, range, selection range, and language id

#### Scenario: Symbol provider is unavailable

- **WHEN** no document symbol provider is available for an eligible file
- **THEN** the extension MAY use a lightweight local fallback extractor
- **AND** fallback symbol entries are marked as approximate

#### Scenario: Go to symbol navigation

- **WHEN** `fastIndexer.goToSymbol` is invoked
- **THEN** the extension shows a quick pick of symbol matches from the symbol index
- **AND** selecting a result opens the file at the symbol selection range when available

### Requirement: Find usages

The extension SHALL provide a focused usage-discovery command that prefers VS Code language semantics.

#### Scenario: Reference provider is available

- **WHEN** `fastIndexer.findUsages` is invoked for a symbol and a VS Code reference provider is available
- **THEN** the extension requests references from the provider
- **AND** presents returned locations to the user

#### Scenario: Reference provider is unavailable

- **WHEN** `fastIndexer.findUsages` is invoked and no reference provider can provide results
- **THEN** the extension MAY search the local text and symbol indexes for matching identifier candidates
- **AND** presents fallback results as approximate local matches
- **AND** does not present those fallback results as semantically equivalent to provider-backed results

### Requirement: Find implementations

The extension SHALL provide a focused implementation-discovery command that prefers VS Code language semantics.

#### Scenario: Implementation provider is available

- **WHEN** `fastIndexer.findImplementations` is invoked for a symbol and a VS Code implementation provider is available
- **THEN** the extension requests implementations from the provider
- **AND** presents returned locations to the user

#### Scenario: Implementation provider is unavailable

- **WHEN** `fastIndexer.findImplementations` is invoked and no implementation provider can provide results
- **THEN** the extension MAY search the local symbol index for implementation-like candidates
- **AND** presents fallback results as approximate local matches
- **AND** does not present those fallback results as semantically equivalent to provider-backed results

### Requirement: Rebuild index command

The extension SHALL provide an explicit command for rebuilding all local index state.

#### Scenario: User rebuilds the index

- **WHEN** `fastIndexer.rebuildIndex` is invoked
- **THEN** the extension cancels current index work
- **AND** clears local index state
- **AND** rebuilds file, text, and symbol indexes from the current workspace
- **AND** reports progress and completion or failure

### Requirement: Configuration settings

The extension SHALL expose configuration settings that let users tune indexing behavior.

#### Scenario: User changes indexing configuration

- **WHEN** a `fastIndexer.*` setting changes
- **THEN** the extension applies the new behavior without restart where practical
- **AND** prompts for or performs a rebuild when existing index state is no longer valid

#### Scenario: Indexing is disabled

- **WHEN** `fastIndexer.enabled` is false
- **THEN** background indexing does not run
- **AND** commands explain that indexing is disabled or use provider-only behavior where applicable

### Requirement: Command contributions

The extension SHALL contribute the required navigation and discovery commands.

#### Scenario: Package contributes commands

- **WHEN** the extension manifest is installed
- **THEN** VS Code recognizes these command identifiers:
  - `fastIndexer.goToFile`
  - `fastIndexer.goToSymbol`
  - `fastIndexer.goToText`
  - `fastIndexer.findUsages`
  - `fastIndexer.findImplementations`
  - `fastIndexer.rebuildIndex`

### Requirement: Responsiveness

The extension SHALL keep VS Code responsive during indexing and searches.

#### Scenario: Large workspace is indexed

- **WHEN** the workspace contains many files
- **THEN** indexing work is chunked, cancellable, and bounded by configuration
- **AND** commands remain usable with partial results while indexing continues

#### Scenario: Search is cancelled

- **WHEN** a user dismisses a quick pick or cancels a long-running operation
- **THEN** pending search or provider work is cancelled when supported
- **AND** no stale result should open an editor after cancellation
