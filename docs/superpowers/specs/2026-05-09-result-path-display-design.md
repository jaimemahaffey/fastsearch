# Result Path Display Design

## Problem

FastSearch currently shows `file:///...` URI strings in user-facing search result details for file-backed results. The underlying URI is correct for navigation, but the displayed value is noisy and harder to scan than a plain path.

## Goal

Show plain path strings in user-facing result details while keeping raw URIs unchanged for internal navigation and identity.

## Scope

This change applies to user-facing search results produced by the shared command-search pipeline:

- file results
- text results
- symbol results
- usage results
- implementation results

It also applies to semantic symbol detail strings so the displayed path remains plain even when semantic metadata appends counts and provider provenance.

## Design

### Display-only normalization

FastSearch should keep `candidate.uri` as the original URI string and continue opening results through `vscode.Uri.parse(candidate.uri)`.

Only the displayed `detail` string should change. For file-backed results, the detail should be formatted as a plain path string instead of a `file:///...` URI string.

### Formatting boundary

The normalization should live in the shared command-search candidate-building layer so all result types stay consistent. This keeps the change small and avoids duplicating path-formatting logic across individual commands.

### Semantic detail behavior

`getSemanticSymbolDetail(...)` should use the cleaned display path as its leading segment. Semantic suffixes such as reference counts, implementation counts, and provider name should remain unchanged.

## Non-Goals

- changing how results are opened
- changing stored URIs or persistence format
- converting every displayed path to workspace-relative format
- altering ranking, deduplication, or provider-first behavior

## Testing

Update command-search tests to verify that all shared candidate builders emit plain displayed paths instead of `file:///...` strings, including semantic symbol detail formatting. Existing command-level tests should continue to validate behavior without requiring navigation changes.
