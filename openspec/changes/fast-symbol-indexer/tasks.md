# Tasks

## 1. Extension Foundation

- [ ] Create a TypeScript VS Code extension package for `fast-symbol-indexer`.
- [ ] Register activation events and command contributions.
- [ ] Add configuration contributions under `fastIndexer.*`.
- [ ] Add extension logging and lightweight status reporting.

## 2. Indexing Services

- [ ] Implement `IndexCoordinator` with initial build, incremental update, rebuild, cancellation, and readiness state.
- [ ] Implement `FileIndex` for workspace-relative file discovery and fuzzy lookup.
- [ ] Implement `TextIndex` for eligible text-file search with file size, binary, and ignore handling.
- [ ] Implement `SymbolIndex` using VS Code document symbol providers where available.
- [ ] Implement workspace watchers for create, change, delete, save, and open-document update flows.

## 3. Navigation Commands

- [ ] Implement `fastIndexer.goToFile` quick-pick navigation.
- [ ] Implement `fastIndexer.goToSymbol` quick-pick navigation.
- [ ] Implement `fastIndexer.goToText` text search quick-pick navigation.
- [ ] Ensure quick picks support cancellation, partial index results, and clear empty states.

## 4. Discovery Commands

- [ ] Implement `fastIndexer.findUsages` using VS Code reference providers first.
- [ ] Add local index fallback for usage discovery when providers are unavailable.
- [ ] Implement `fastIndexer.findImplementations` using VS Code implementation providers first.
- [ ] Add local symbol-index fallback for implementation discovery when providers are unavailable.

## 5. Rebuild And Configuration

- [ ] Implement `fastIndexer.rebuildIndex` with progress, cancellation, and clear failure reporting.
- [ ] Honor enablement, include/exclude, file-size, debounce, and fallback settings.
- [ ] React to configuration changes without requiring VS Code restart where practical.

## 6. Validation

- [ ] Add unit tests for file, text, and symbol index behavior.
- [ ] Add integration tests for command registration and quick-pick command flows.
- [ ] Add tests for incremental updates after file create, edit, delete, and rename.
- [ ] Add tests for provider-first usages and implementations behavior.
- [ ] Validate responsiveness in a large workspace fixture.