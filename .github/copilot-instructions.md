# Copilot Instructions for Fast Symbol Indexer

## Build and test commands

- Install dependencies: `npm install`
- Type-check: `npm run typecheck`
- Build compiled output: `npm run compile`
- Run the full test suite: `npm test`
- Run a single test by name with Mocha grep: set `MOCHA_GREP` and run `npm test`
  - PowerShell example: ``$env:MOCHA_GREP='restores a persisted snapshot'; npm test``
  - The test runner reads `MOCHA_GREP` in `src/test/suite/index.ts`, so this works for individual test names or suite names.
- There is currently no dedicated lint script in `package.json`.

## High-level architecture

- This repository is a VS Code extension. `src/extension.ts` is the composition root: it reads `fastIndexer.*` settings, creates the indexes, restores persisted state, registers commands, and wires file/config watchers.
- The core runtime is a three-index model:
  - `src/indexes/fileIndex.ts` tracks workspace files and ranking metadata.
  - `src/indexes/textIndex.ts` stores searchable file contents for eligible text files.
  - `src/indexes/symbolIndex.ts` stores flattened document symbols and approximate fallback candidates.
- `src/core/indexCoordinator.ts` owns lifecycle state (`warming`, `ready`, `stale`, `rebuilding`) and rebuild orchestration. Startup restores a persisted snapshot first, then runs background reconciliation so commands can stay usable before a full rebuild finishes.
- `src/core/persistenceStore.ts` persists one JSON snapshot per workspace under the extension storage directory. Persistence compatibility depends on schema version, workspace identity, and a config hash that includes ignore-file inputs.
- `src/core/workspaceWatcher.ts` and `src/core/ignoreRules.ts` decide whether a file should participate in indexing. Effective filtering is the combination of built-in heavy-path exclusions, `fastIndexer.exclude`, and optional `.gitignore`-style rule files from `fastIndexer.ignoreFiles` / `fastIndexer.sharedIgnoreFiles`.
- Provider-backed editor intelligence is isolated behind `src/bridge/providerBridge.ts`. `findUsages` and `findImplementations` call VS Code providers first and only fall back to local approximate matches when the provider path returns nothing and config allows it.
- Quick-pick search UX is centralized in `src/shared/commandSearch.ts`. `goToFile`, `goToText`, `goToSymbol`, usages, and implementations all flow through the same candidate shaping, ranking, deduping, and completion-style UI.
- External CLI tools are optional accelerators, not the primary path: `goToText` can merge ripgrep hits with indexed text results, and command narrowing can optionally use `fzf` via `src/externalTools/commandSearchProviders.ts`.
- Builds are produced by `esbuild.mjs`, which recursively bundles every `src/**/*.ts` file into the matching `dist/` tree. Tests execute the compiled JS from `dist/test`.

## Key conventions

- Preserve the provider-first contract. If you change usages, implementations, or symbol navigation, provider-backed results must stay preferred over approximate local fallbacks.
- Keep approximate results explicitly labeled. Existing command code uses `approximate: true` plus UI text like `Approximate match` / `Approximate local match`; do not blur that distinction.
- Keep activation responsive. `activate()` should not block on a full workspace scan; the intended pattern is restore persisted data, mark the coordinator state, and let indexing continue asynchronously.
- Reuse `src/shared/commandSearch.ts` for new search-style commands instead of building separate quick-pick logic. Respect the existing config flags: `completionStyleResults`, `fuzzySearch`, `useRipgrep`, and `useFzf`.
- Rebuild behavior is config-driven. Settings in `REBUILD_KEYS` inside `src/configuration.ts` are treated as rebuild-triggering inputs, and ignore-file changes refresh the matcher before queuing a rebuild.
- File filtering is path-normalized and Windows-aware. Existing code consistently normalizes `\` to `/` for matching and uses `windowsPathsNoEscape` with `minimatch`; follow that pattern for new glob or ignore logic.
- Tests are mostly VS Code integration-style tests with patched APIs, not pure unit tests. Follow the existing helpers in `src/test/suite/helpers/` (`patchProperty`, `restoreProperty`, `FakeQuickPick`) when extending command or activation coverage.
- When changing indexing or persistence behavior, check both the runtime code and the activation/persistence tests in `src/test/suite/`, because many behaviors are verified through activation-time orchestration rather than isolated unit coverage.

## OpenSpec and repo workflow

- This repo keeps product/change context in `openspec/`. Read relevant files in `openspec/specs/` and any active change under `openspec/changes/<change-name>/` before implementing work tied to an existing change.
- Repo-local GitHub prompt/skill definitions live under `.github/prompts/` and `.github/skills/`. If a future session is working through an OpenSpec change, align with those local workflows instead of inventing a separate process.
- Design notes already live in `docs/superpowers/specs/`; use them as context when they overlap the current task, especially for indexing, persistence, or command-search behavior.
