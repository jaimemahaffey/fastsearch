## 1. Search configuration and provider scaffolding

- [x] 1.1 Add configuration for fuzzy/completion search behavior and optional external provider usage.
- [x] 1.2 Introduce a normalized command-search result model and provider adapter interface for built-in and external candidate sources.
- [x] 1.3 Add runtime detection and safe process wrappers for optional `rg` and `fzf` execution with explicit fallback behavior.

## 2. Built-in fuzzy and completion-style command behavior

- [x] 2.1 Implement shared fuzzy-ranking utilities for fast indexer command candidates.
- [x] 2.2 Update file, symbol, and text command flows to use completion-style ranking, narrowing, and richer candidate metadata.
- [x] 2.3 Update usage and implementation discovery flows to use the same ranked command-search behavior while preserving provider-first semantics.

## 3. Optional external search acceleration

- [x] 3.1 Integrate `rg` as an optional candidate-gathering path for text-oriented or broad workspace search flows.
- [x] 3.2 Integrate `fzf` as an optional interactive narrowing path without replacing the default VS Code command UX.
- [x] 3.3 Ensure missing, disabled, or failing external tools fall back cleanly to built-in search behavior.

## 4. Validation and packaging

- [x] 4.1 Add tests for fuzzy ranking, completion-style updates, and provider fallback behavior.
- [x] 4.2 Add tests for external-tool configuration, availability detection, and degraded behavior when `rg` or `fzf` is unavailable.
- [x] 4.3 Update build and packaging paths so any new runtime dependencies ship correctly and command behavior remains responsive in large workspaces.
