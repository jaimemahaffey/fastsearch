# Design Notes

## Goals

- Provide fast local navigation for files, symbols, text, usages, and implementations.
- Keep command interactions responsive even while indexing is incomplete.
- Use VS Code language-provider APIs for semantic answers when they exist.
- Use local indexes for speed, fallback behavior, and broad workspace discovery.
- Avoid broad IDE features outside navigation and discovery.

## Architecture

The extension should be organized around a small set of services:

- `ExtensionHost`: activates the extension, wires commands, initializes services, and disposes resources.
- `IndexCoordinator`: owns indexing lifecycle, rebuild orchestration, cancellation, status, and scheduling.
- `FileIndex`: stores workspace-relative file metadata and filename tokens.
- `TextIndex`: stores searchable text tokens or trigrams for eligible files.
- `SymbolIndex`: stores symbols discovered from `vscode.executeDocumentSymbolProvider`, language providers, and fallback parsers where appropriate.
- `WorkspaceWatcher`: listens to file creation, deletion, rename, save, and open-document changes.
- `NavigationCommands`: implements quick-pick workflows and editor reveal behavior.
- `LanguageFeatureBridge`: calls VS Code commands/providers for references and implementations before using local fallbacks.

## Activation

Activation should be lazy but practical:

- Activate on the contributed commands.
- Activate on workspace open when indexing is enabled.
- Avoid heavy synchronous work during activation.
- Start index initialization in the background after command registration.

## Indexing Lifecycle

Initial indexing should scan workspace folders using VS Code workspace APIs and configured include/exclude rules. It should batch work, yield between batches, and support cancellation when a rebuild supersedes in-flight work.

Incremental updates should be driven by workspace file-system watchers and text document events. The extension should update open documents from memory, update saved documents from disk, remove deleted files, and coalesce rapid changes with a debounce.

The index should expose readiness states such as `idle`, `indexing`, `partial`, `stale`, and `error`, allowing commands to show usable partial results instead of blocking.

## File Index

The file index should track workspace-relative paths, basenames, extensions, modified timestamps where available, file size, and workspace folder identity. It should support fuzzy matching by basename and path segments.

## Text Index

The text index should index eligible text files only. It should obey maximum file size, binary detection, ignored path patterns, and enabled language filters. It should support fast substring-style search and return enough context to preview matches in quick pick items.

## Symbol Index

The symbol index should prefer VS Code document symbol providers. It should store symbol name, kind, container name, file URI, range, selection range, and language id when available. It may fall back to lightweight lexical extraction for languages without providers, but fallback results must be clearly treated as less semantic.

## Commands

`fastIndexer.goToFile` should show a quick pick backed by `FileIndex`, then open the selected file.

`fastIndexer.goToSymbol` should show a quick pick backed by `SymbolIndex`, then open the selected file at the symbol selection range.

`fastIndexer.goToText` should prompt for text or use the quick-pick filter text, search `TextIndex`, show contextual results, and open the selected match.

`fastIndexer.findUsages` should run VS Code reference providers for the active symbol when possible. If no provider is available or it returns no usable result, the command may fall back to text/symbol index matches for the selected identifier.

`fastIndexer.findImplementations` should run VS Code implementation providers for the active symbol when possible. If no provider is available, it may fall back to symbol-index candidates that match common implementation shapes without claiming full semantic certainty.

`fastIndexer.rebuildIndex` should cancel current indexing, clear local index state, rebuild from the current workspace, and report progress.

## Responsiveness

- Commands must open quickly and show partial results when indexes are warming.
- Long operations must use cancellation tokens.
- Indexing must run in bounded batches and avoid blocking the extension host.
- Watcher events must be debounced and coalesced.
- Large files and ignored paths must be skipped early.
- Errors in one file must not fail the whole index.

## Configuration

The extension should contribute settings under `fastIndexer.*` for enabling indexing, include/exclude patterns, maximum file size, debounce timing, symbol indexing enablement, text indexing enablement, persistence behavior, and language-provider fallback behavior.

## Risks

- VS Code language-provider support varies by language and installed extensions.
- Indexing too much text can consume memory in large repositories.
- File watcher storms can cause churn without careful debouncing.
- Fallback usage and implementation results may be approximate; UI copy should not overstate semantic certainty.
- `npm audit` currently reports dev-only vulnerabilities through `mocha` transitive dependencies (`diff` and `serialize-javascript`). A zero-audit lockfile can be produced with overrides, but that forces versions outside `mocha`'s declared dependency ranges and raises the effective install baseline to Node 20 because `serialize-javascript@7.0.5` requires it. Task 1 leaves those findings unresolved until `mocha` ships a stable compatible dependency update or the project explicitly adopts that higher-risk override strategy and Node baseline.

## Open Questions

- Should index persistence be enabled by default or rebuilt per session for simplicity?
- What is the minimum supported VS Code version?
- Should the first release support multi-root workspaces fully or treat them as separate indexed roots behind one UI?
