# Fast Symbol Indexer

## Why

VS Code navigation can feel slow in large workspaces when commands repeatedly scan the filesystem or wait on language services. Developers need a lightweight extension that keeps local file, text, and symbol indexes warm so common discovery workflows respond quickly and predictably.

This change proposes a focused TypeScript VS Code extension, tentatively named `fast-symbol-indexer`, that provides ReSharper-like navigation and discovery without expanding into refactoring, inspections, formatting, code generation, or other broad IDE features.

## What Changes

- Add extension activation for workspace-based indexing and command registration.
- Maintain local indexes for workspace files, searchable text, and discovered symbols.
- Keep indexes current through initial builds, incremental file-system updates, document edits, and explicit rebuilds.
- Contribute quick-pick navigation commands for files, symbols, and text matches.
- Contribute commands for finding usages and implementations using VS Code providers where available, with local index fallbacks where useful.
- Add configuration settings for enablement, indexing scope, ignored paths, size limits, debounce behavior, and language-provider fallback behavior.
- Ensure indexing and search remain responsive through cancellation, batching, progress reporting, and non-blocking background work.

## Out Of Scope

- Refactoring commands.
- Code inspections, diagnostics, or linting.
- Formatting.
- Code generation.
- Project model replacement for language servers.
- Remote/cloud indexing.
- Persisting source code outside the local machine.

## Impact

- Adds a new VS Code extension package implemented in TypeScript.
- Adds command contributions:
  - `fastIndexer.goToFile`
  - `fastIndexer.goToSymbol`
  - `fastIndexer.goToText`
  - `fastIndexer.findUsages`
  - `fastIndexer.findImplementations`
  - `fastIndexer.rebuildIndex`
- Adds a new capability spec for fast workspace indexing and navigation.
- Requires careful testing against large workspaces, file watcher churn, cancellation, and language-provider availability differences.

## Success Criteria

- Opening a workspace starts a background index without blocking VS Code startup.
- Quick-pick commands return useful results from the local index while continuing to refine results as needed.
- File edits and creates/deletes update indexes incrementally without requiring a full rebuild.
- Find usages and implementations prefer VS Code language providers when available and degrade gracefully when they are unavailable.
- Users can rebuild the index and tune indexing limits through settings.
- The extension remains focused only on fast navigation and discovery workflows.