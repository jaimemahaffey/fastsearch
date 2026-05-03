## Why

The fast indexer commands currently require users to choose a separate command for symbol, text, or file search before they can start narrowing results. Adding a ReSharper-style `Ctrl+T` cycle now would make cross-mode navigation faster and keep users in a single keyboard-driven flow.

## What Changes

- Add a new fast indexer command that starts in **symbol** mode and cycles through **text** and **file** modes on repeated invocation.
- Bind the new cycling command to `Ctrl+T` so users can reach the shared entry point with one shortcut.
- Reuse the existing fast symbol, text, and file search flows behind a single mode-aware command experience rather than replacing the current commands.
- Show the active mode in the command UI so users can tell whether they are searching symbols, text, or files while cycling.
- Preserve the existing dedicated commands for direct file, text, and symbol access.
- Expand automated coverage for cycle order, reset behavior, UI mode indicators, and keybinding/manifest wiring.

## Capabilities

### New Capabilities
- `fast-command-mode-cycling`: Unified command entry point for cycling between symbol, text, and file search modes with repeated invocation.

### Modified Capabilities

## Impact

- Affected code: extension activation, command registration, command search presentation, manifest command/keybinding contribution, and command tests.
- Affected systems: VS Code command palette/keybinding UX, Quick Pick coordination, and fast indexer mode-specific search handlers.
- Dependencies: no new external runtime dependency, but the command flow will add short-lived cycling state and new keybinding wiring.
