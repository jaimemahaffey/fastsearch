## Context

The extension already has dedicated commands for file, text, and symbol search, and those commands now share fuzzy-ranked, completion-style search behavior. What is still missing is a single entry point that lets users move between those modes quickly without backing out to the command palette or remembering separate shortcuts.

The requested behavior is modeled after ReSharper's `Ctrl+T` flow: the same shortcut should move through multiple navigation modes while staying keyboard-centric. The design therefore needs to add a small amount of statefulness around command invocation while preserving the existing dedicated commands and keeping Quick Pick as the core UX surface.

## Goals / Non-Goals

**Goals:**
- Add one unified fast indexer command that cycles through symbol, text, and file modes in a predictable order.
- Bind the cycling entry point to `Ctrl+T`.
- Reuse the existing mode-specific search implementations instead of rebuilding separate search logic.
- Make the active mode visible in the search UI.
- Reset cycling cleanly so the next fresh invocation starts from the default mode again.

**Non-Goals:**
- Removing or renaming the existing dedicated file, text, or symbol commands.
- Extending the cycle to usages, implementations, or other future modes.
- Replacing Quick Pick with a custom editor, tree view, or terminal-first picker.
- Matching every ReSharper nuance beyond the core repeated-invocation mode cycling behavior.

## Decisions

### 1. Introduce a dedicated cycle command with a fixed mode order

The extension will add a new command specifically for mode cycling. The cycle order will be **symbol → text → file → symbol**, with the first fresh invocation always starting in symbol mode.

**Alternatives considered:**
- **Replace existing commands with the cycling command only**: rejected because direct mode-specific commands are still useful and already integrated into the extension.
- **Make file the default mode**: rejected because symbol search is the closest match to the ReSharper-style "go to anything code-oriented" entry point.

### 2. Track a short-lived cycle session in extension state

The implementation will keep a small in-memory cycle session that records the currently active mode and whether the unified picker flow is still active. Repeated invocation while a cycle session is active will advance to the next mode; completion, cancellation, or an expired idle window will reset the session back to the initial mode.

**Alternatives considered:**
- **Persist the last mode indefinitely**: rejected because it would make `Ctrl+T` environment-dependent and less predictable.
- **Advance modes without any session concept**: rejected because it would make repeated invocation indistinguishable from a fresh invocation.

### 3. Reuse existing mode-specific command presenters through a shared coordinator

The new cycle command should call into the existing symbol, text, and file search flows through a shared coordinator rather than duplicating search code. The coordinator will be responsible for selecting the active mode, decorating the UI with mode labels/placeholders, and resetting or advancing the session.

**Alternatives considered:**
- **Copy each mode flow into a separate unified command implementation**: rejected because it would duplicate ranking, Quick Pick, and external-provider behavior.

### 4. Surface the active mode in the Quick Pick placeholder/title

Users need immediate feedback about which mode the current invocation is targeting. The active mode will therefore be included in the command placeholder or title, such as `Search symbols`, `Search text`, or `Search files`, and the cycling command should update that label when the mode advances.

**Alternatives considered:**
- **No explicit mode label**: rejected because repeated `Ctrl+T` would feel ambiguous and error-prone.

### 5. Keep the new keybinding additive and backward-compatible

The extension will contribute `Ctrl+T` for the new cycling command while leaving current commands available in the command palette and existing manifest contributions intact.

**Alternatives considered:**
- **Move all mode-specific commands behind the new keybinding only**: rejected because discoverability and direct access would regress.

## Risks / Trade-offs

- **Stateful cycling can become confusing if it does not reset reliably** -> Mitigation: reset on accept, hide, and idle expiry, and cover those behaviors with tests.
- **Reopening or updating Quick Picks across modes may introduce UX flicker** -> Mitigation: centralize the cycle coordinator and keep transitions lightweight.
- **Keybinding conflicts with editor defaults or user expectations** -> Mitigation: keep the command additive and easy to rebind while documenting the default binding in the manifest.
- **Mode-specific search flows may drift apart over time** -> Mitigation: route the cycle command through the same shared search presenters already used by dedicated commands.

## Migration Plan

1. Add the new cycling command and manifest keybinding without removing any current command.
2. Introduce cycle session state and mode-order logic behind the new unified entry point.
3. Wire symbol, text, and file flows into the coordinator with visible mode labels.
4. Add automated coverage for cycle order, reset conditions, and UI labeling.
5. Roll back safely by removing the unified command/keybinding while leaving dedicated commands untouched.

## Open Questions

- Whether cycling should reset strictly on picker hide/accept or also after a short idle timeout when the picker remains open.
- Whether the mode indicator should live only in the placeholder or also in a dedicated Quick Pick title for clearer visual feedback.
