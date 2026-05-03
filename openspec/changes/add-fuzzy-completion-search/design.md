## Context

The repository already includes fast indexer navigation and discovery commands, but their current search behavior is still optimized around straightforward local matching and static result sets. The requested change adds two cross-cutting concerns across those commands: stronger fuzzy ranking that tolerates partial or non-contiguous input, and a completion-engine-style interaction model that keeps results useful while the user is still narrowing intent.

This work also introduces optional external-process integration. `rg` can improve text candidate gathering in large workspaces, and `fzf` can improve interactive filtering when it is explicitly enabled and available. Because those tools are not guaranteed to exist, the design must preserve a fully functional built-in path and degrade cleanly when external tools are missing or fail.

## Goals / Non-Goals

**Goals:**
- Improve fast indexer command matching with fuzzy-ranked results instead of basic substring-only behavior.
- Make command result lists feel more like a completion engine, with better incremental narrowing, ranking, and previews.
- Support optional `rg` and `fzf` acceleration where they materially improve command responsiveness.
- Keep the extension usable without external tools and without requiring a different primary UX model.
- Define configuration and fallback behavior clearly enough that the implementation can be tested and packaged safely.

**Non-Goals:**
- Replacing VS Code Quick Pick with a terminal-first workflow for all commands.
- Making `rg` or `fzf` mandatory runtime dependencies.
- Redesigning the underlying index persistence model or command set.
- Adding language-semantic behavior beyond the current file, text, symbol, usage, and implementation command scope.

## Decisions

### 1. Keep VS Code command UX as the default surface

The extension should continue to use VS Code-native command flows as the primary UX surface. Completion-style behavior will be implemented through better ranking, richer candidate metadata, and more responsive incremental updates rather than by forcing users into an external terminal picker.

**Alternatives considered:**
- **Terminal-first FZF workflow**: rejected because it would fragment the command experience, complicate packaging, and fail in environments where terminal tooling is unavailable.
- **Purely internal ranking only**: rejected because it leaves performance gains from `rg` untapped for large text-oriented searches.

### 2. Treat external tools as optional providers behind a normalized search adapter

The implementation should introduce a search adapter layer that can gather candidates from built-in indexes or optional external providers. Command handlers should consume a normalized result model so ranking, preview rendering, and selection logic remain consistent regardless of the source.

**Alternatives considered:**
- **Directly invoking `rg`/`fzf` from each command**: rejected because it would duplicate process, error, and fallback handling.
- **External tools only for one command**: rejected because the user request applies to fast indexer commands broadly and would otherwise create inconsistent behavior.

### 3. Use `rg` mainly for candidate gathering, not as the full interaction surface

`rg` is best suited to fast text candidate discovery and broad workspace scans. It should be used where command responsiveness benefits from streaming or broad text matching, while final ranking and display stay within the extension's normalized result pipeline.

**Alternatives considered:**
- **Use `rg` output directly as the final UX**: rejected because it would reduce control over ranking, previews, and cross-command consistency.

### 4. Make `fzf` optional and explicitly configurable

`fzf` can improve interactive narrowing, but only when enabled and available. The extension should treat it as an optional accelerator or experimental picker path, not as a default requirement. When `fzf` is absent, disabled, or errors, commands must continue with the internal completion-style flow.

**Alternatives considered:**
- **Always use `fzf` when installed**: rejected because it creates surprising environment-dependent behavior.
- **Do not support `fzf` at all**: rejected because the user explicitly called it out as an acceptable tool to leverage.

### 5. Add explicit configuration for fuzzy/completion behavior and external tools

Configuration should control whether external providers are used, which commands may use them, and how the extension falls back when a provider is unavailable. This keeps behavior predictable and makes testing easier.

**Alternatives considered:**
- **Implicit auto-detection only**: rejected because it obscures behavior and makes reproducible testing harder.

## Risks / Trade-offs

- **External process integration increases complexity** -> Mitigation: isolate `rg`/`fzf` access behind a provider adapter and require graceful fallback to built-in behavior.
- **Different data sources can produce inconsistent ranking** -> Mitigation: normalize candidate records before display and run a shared ranking layer where possible.
- **Large workspaces can still stress interactive updates** -> Mitigation: cap candidate sets, stream or batch external results, and preserve partial-result behavior.
- **Packaging/runtime issues can appear when external integration adds dependencies** -> Mitigation: keep runtime imports explicit, bundle what must ship, and treat system binaries as optional.

## Migration Plan

1. Add the new command-search capability and configuration surface in a backward-compatible way.
2. Implement internal fuzzy ranking first so the commands improve even without external tools.
3. Add optional `rg` and `fzf` providers behind feature flags or config switches.
4. Expand automated coverage for ranking, fallback, disabled-tool behavior, and large-workspace responsiveness.
5. Keep rollback simple by allowing external-provider usage to be disabled without removing the internal search path.

## Open Questions

- Whether `fzf` should be exposed as a global switch or as command-specific opt-in behavior.
- Whether completion-style updates should be fully live while typing for every command, or phased in per command based on performance.
