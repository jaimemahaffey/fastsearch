## Why

The fast indexer commands currently rely on simple local search behavior, which makes large workspaces harder to navigate when users only know partial names or want ranked, interactive results. Improving the commands now would make the extension feel closer to modern editor completion and fuzzy-finder workflows while taking advantage of proven tools like ripgrep and FZF where they help.

## What Changes

- Add fuzzy-ranked search behavior for fast indexer command inputs so partial and out-of-order matches are surfaced more effectively.
- Add completion-engine-style result presentation so commands can show stronger ranking, previews, and more useful interactive narrowing as users type.
- Allow the extension to use ripgrep for fast text-oriented candidate gathering where it improves command responsiveness or coverage.
- Allow the extension to use FZF-style selection workflows where that integration improves interactive filtering without replacing the extension's core command UX.
- Expand tests and configuration coverage around external tool usage, ranking behavior, and degraded behavior when optional tools are unavailable.

## Capabilities

### New Capabilities
- `fast-command-search`: Fuzzy and completion-style search behavior for fast indexer commands, including ranked matching, interactive narrowing, and optional ripgrep/FZF-backed acceleration.

### Modified Capabilities

## Impact

- Affected code: command handlers, ranking/search helpers, configuration, and extension activation/runtime wiring.
- Affected systems: VS Code command UX, local workspace indexing, optional external process integration for ripgrep/FZF.
- Dependencies: optional use of installed `rg` and `fzf` binaries, plus any packaging/runtime changes needed to support that integration safely.
