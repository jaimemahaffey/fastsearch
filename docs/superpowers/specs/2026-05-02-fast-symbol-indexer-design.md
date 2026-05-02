# Fast Symbol Indexer Design

## Problem

Implement the OpenSpec change for a VS Code extension that keeps local file, text, and symbol indexes warm so navigation and discovery commands stay fast and responsive in a workspace.

## Scope

- Build the first implementation as a new TypeScript VS Code extension package.
- Support single-root workspaces in v1.
- Persist indexes on disk in the extension storage path.
- Keep provider-backed results first for symbols, usages, and implementations.
- Use approximate local fallbacks only where the OpenSpec allows them.

## Out of Scope

- Refactoring, inspections, formatting, and code generation.
- Remote or cloud indexing.
- Full multi-root support in v1.
- Replacing language servers or project models.

## Recommended Approach

Use a service-oriented architecture with separate file, text, and symbol indexes coordinated by a single indexing lifecycle service. Persist each index independently with a versioned manifest so startup can hydrate quickly from disk and reconcile in the background.

This approach keeps responsibilities narrow, makes testing straightforward, and matches the OpenSpec requirement that commands remain responsive while indexing warms or rebuilds.

## Architecture

### Extension Activation

`extension.ts` activates the extension, registers commands and configuration listeners, wires watchers, and starts warm indexing without heavy synchronous work on the extension host.

### Core Services

- `IndexCoordinator` owns indexing state, lifecycle transitions, cancellation, debounce, rebuild orchestration, and progress reporting.
- `FileIndex` stores workspace-relative file metadata and fuzzy-match tokens.
- `TextIndex` stores searchable text data for eligible files only.
- `SymbolIndex` stores provider-backed document symbols and approximate fallback symbols when needed.
- `PersistenceStore` reads and writes cache files plus a versioned manifest.
- `WorkspaceWatcher` translates file, document, and configuration events into normalized update jobs.
- `ProviderBridge` calls VS Code document symbol, reference, and implementation providers.
- `CommandController` handles quick-pick workflows, status messaging, and editor reveal actions.

### Service Boundaries

Commands call the coordinator and index query APIs rather than touching storage directly. Provider-backed flows remain isolated from approximate fallback logic so semantic and approximate results can be surfaced clearly.

## Indexing Lifecycle

### Startup

1. Load persisted cache files for the current workspace.
2. Mark the indexes as usable but still warming.
3. Start a background reconciliation pass against the workspace.
4. Update cache files only after successful index changes or completed rebuild checkpoints.

### Incremental Updates

The watcher layer listens for file create, change, rename, delete, save, open-document, and configuration-change events. The coordinator coalesces bursty events, updates the affected index entries, and invalidates stale persisted data only for impacted files.

### Rebuild

`fastIndexer.rebuildIndex` cancels active work, clears in-memory state, clears persisted cache files for the workspace, and starts a fresh build with progress reporting and explicit failure messaging.

## Persistence Design

Persist one cache directory per workspace under the extension storage path.

Each workspace cache contains:

- `manifest.json` with schema version, workspace identity, and last successful build metadata
- `files.json` for serialized file index entries
- `text.json` for serialized text index entries
- `symbols.json` for serialized symbol index entries

If the schema version or workspace identity does not match, the cache is discarded and rebuilt.

## Search and Navigation Behavior

### Go To File

Query `FileIndex` with basename and path-segment fuzzy matching. The command opens immediately and can show partial results while the index warms.

### Go To Symbol

Query `SymbolIndex` and prefer provider-backed symbols. Approximate fallback symbols are marked as approximate in the result label or description.

### Go To Text

Query `TextIndex` for fast local text matches and show file path, preview, and match location in quick-pick results.

### Find Usages

Use VS Code reference providers first. If no provider can answer, use approximate local identifier matches from the text and symbol indexes and label them as approximate.

### Find Implementations

Use VS Code implementation providers first. If unavailable, use approximate local symbol candidates based on indexed symbol data and label them as approximate.

## Configuration

Contribute settings under `fastIndexer.*` for:

- enablement
- include and exclude globs
- maximum indexed file size
- debounce interval
- text indexing enablement
- symbol fallback extraction enablement
- provider fallback behavior

Configuration changes should apply without restart where practical. If a setting invalidates persisted state, the extension should prompt for or trigger a rebuild.

## Error Handling and Responsiveness

- Activation must not block on indexing.
- Long-running work must support cancellation.
- Errors for one file must not fail the full index.
- Large files, ignored paths, and binary content must be skipped early.
- Commands must stay usable with partial results and clear empty or warming states.

## Testing Strategy

### Unit Tests

- file index queries and updates
- text index eligibility and search behavior
- symbol index ingestion and fallback labeling
- persistence serialization, hydration, and version invalidation

### Integration Tests

- extension activation and command registration
- quick-pick command flows
- incremental updates after create, edit, rename, and delete events
- provider-first usages and implementations behavior
- rebuild and cancellation flows

### Fixture Coverage

Use small focused fixtures for correctness and a larger workspace fixture for responsiveness and bounded indexing behavior.

## Delivery Notes

- Start with single-root workspace assumptions across index keys and persistence layout.
- Keep persistence formats simple and explicit for easy schema evolution.
- Avoid feature creep outside navigation and discovery.
