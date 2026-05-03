## 1. Command and state scaffolding

- [x] 1.1 Add a new unified cycling command contribution and `Ctrl+T` keybinding in the extension manifest.
- [x] 1.2 Introduce in-memory cycle session state that tracks the active mode order and reset behavior.

## 2. Unified mode-cycling behavior

- [x] 2.1 Implement the unified command coordinator so repeated invocation cycles symbol, text, and file modes.
- [x] 2.2 Update the shared command-search presentation flow to show the active mode label and reset the cycle session on completion or cancellation.
- [x] 2.3 Keep dedicated symbol, text, and file commands working as direct entry points alongside the cycling command.

## 3. Validation

- [x] 3.1 Add tests for cycle order, reset behavior, and mode-indicator updates.
- [x] 3.2 Add activation/manifest coverage for the new command and keybinding contribution.
