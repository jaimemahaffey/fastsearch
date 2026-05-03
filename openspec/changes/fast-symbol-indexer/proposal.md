# Fast Symbol Indexer

## Why

The base fast indexer capability is now substantially implemented: the extension activates, maintains local file/text/symbol indexes, wires navigation and discovery commands, and has follow-on changes for fuzzy completion behavior and mode cycling.

What remains unclear is no longer the broad feature shape. The remaining uncertainty is operational and product-facing:

- how to describe persistence now that the chosen policy is internal cache only rather than a supported user-facing feature,
- how multi-root workspace identity should be defined for cache and index lifecycle purposes,
- and how approximate fallback results should be described so the user experience stays honest.

This change is therefore being narrowed from a bootstrap “build the whole extension” proposal into a “finish the remaining base-capability semantics” proposal.

## What Changes

- Record that persistence is internal-only cache behavior, not a supported configurable feature of the base capability.
- Clarify how multi-root workspaces are identified and handled by the base indexing lifecycle.
- Clarify how approximate fallback results are described in the base capability language.
- Align OpenSpec tasks and design notes with the fact that the core extension surface already exists.

## Out Of Scope

- Rebuilding the already-implemented extension foundation from scratch.
- Folding fuzzy/completion search into the base change.
- Folding command mode cycling into the base change.
- Refactoring commands.
- Code inspections, diagnostics, or linting.
- Formatting.
- Code generation.
- Project model replacement for language servers.
- Remote/cloud indexing.
- Persisting source code outside the local machine.

## Impact

- Refocuses the change on unresolved base-capability semantics instead of already-shipped implementation surfaces.
- Keeps later changes such as fuzzy completion search and command mode cycling as separate historical follow-ons.
- May require small spec or test adjustments once multi-root behavior and approximate-result language are explicitly decided.

## Success Criteria

- The change artifacts accurately describe what is still undecided about the base capability.
- Persistence behavior is clearly documented as internal-only cache behavior rather than a supported public feature.
- Multi-root workspace identity is defined clearly enough to guide future implementation and validation.
- Approximate fallback behavior is described consistently across design and spec language.
