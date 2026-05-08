# Semantic Enrichment Design

## Problem

FastSearch already keeps file, text, and symbol indexes warm and uses VS Code provider commands for document symbols, references, and implementations. The next improvement should make results more semantically accurate without making activation slower, duplicating language-server management, or blurring the distinction between provider-backed and approximate local results.

## Goals

- Improve semantic accuracy for symbol navigation and discovery commands.
- Keep the extension VS Code-native by using VS Code provider APIs rather than managing language servers directly.
- Preserve fast baseline search while semantic metadata warms in the background.
- Keep provider-backed results preferred over approximate local fallbacks.
- Add responsiveness regression coverage so semantic enrichment cannot make core search feel slower.

## Non-Goals

- Starting, configuring, or supervising language servers directly.
- Replacing VS Code language extensions or project models.
- Adding refactoring, formatting, inspection, or code generation features.
- Blocking activation or basic index availability on semantic provider calls.

## Recommended Approach

Add semantic enrichment over the existing indexes. The extension should keep the current file, text, and symbol indexes as the fast baseline, then enrich symbol records opportunistically through a broader `ProviderBridge` that wraps VS Code semantic provider commands.

This approach gives better accuracy while staying aligned with VS Code's existing language-server integration. Direct LSP management would duplicate editor infrastructure, require language-specific setup, and add failure modes without clear benefit for a VS Code-only extension.

## Architecture

### Provider Bridge

Extend `src/bridge/providerBridge.ts` into the single boundary for semantic provider calls. It should continue to expose document symbols, references, and implementations, then add wrappers for definitions, declarations, type definitions, hover summaries, and hierarchy providers where VS Code exposes stable command APIs.

Provider calls should return typed records with provenance and should not throw through command callers. The bridge should surface provider failures explicitly to the enrichment service so errors can be logged or represented in semantic status without turning into success-shaped empty data.

### Semantic Enrichment Service

Add a service beside the current indexes that schedules provider-backed enrichment work. It should enrich open files and likely-to-be-used symbols first, then warm remaining indexed symbols gradually.

The service owns concurrency, timeout, cancellation, retry policy, and stale-work detection. It should be controlled by configuration and coordinated with rebuild generation so old provider results cannot overwrite newer index state.

### Symbol Metadata

Extend symbol records or add a companion semantic index with optional metadata:

- definition target
- declaration target
- type-definition target
- implementation targets or count
- reference count
- provider provenance
- enrichment status
- last enrichment time
- confidence

Metadata should be optional so existing indexed symbols remain valid before enrichment completes.

## Data Flow

1. Activation restores existing persisted indexes and starts normal background indexing.
2. The coordinator marks baseline indexes usable as it does today.
3. The semantic enrichment service receives changed or newly indexed symbols.
4. The service schedules bounded provider calls through `ProviderBridge`.
5. Completed enrichment updates semantic metadata if the current rebuild generation still matches.
6. Commands merge baseline candidates with semantic metadata for ranking, presentation, and provider-first behavior.
7. Persistence writes semantic metadata only after successful enrichment checkpoints.

## Search and Command Behavior

### Go To Symbol

`goToSymbol` should keep using `SymbolIndex` as the source of candidates, but candidate shaping should include semantic metadata when available. Ranking should boost provider-confirmed symbols, exact kind/container matches, symbols with definitions, and recently enriched records. Approximate symbols remain lower-ranked and visually distinct.

### Find Usages and Find Implementations

Provider results remain authoritative at command time. If the active provider returns results, the command uses those results and does not fall back. If providers return no results and fallback is enabled, enriched metadata can improve fallback ranking and descriptions, but the UI must still label fallback results as approximate.

### Future Commands

After enrichment proves useful, add commands only where the enriched index can answer quickly:

- Go to Definition from Index
- Go to Type Definition from Index
- Find Related Symbols
- Show Symbol Summary

These should reuse the shared command-search pipeline instead of adding new quick-pick logic.

## Configuration

Add settings such as:

- `fastIndexer.semanticEnrichment`: enables background semantic enrichment.
- `fastIndexer.semanticConcurrency`: limits simultaneous provider calls.
- `fastIndexer.semanticTimeoutMs`: bounds individual provider requests.

Configuration that changes persisted semantic metadata compatibility should participate in the persistence config hash. Disabling semantic enrichment should leave baseline indexing and existing provider-first command-time behavior intact.

## Error Handling and Responsiveness

Provider calls must be bounded and non-fatal. Missing providers, slow providers, thrown errors, and cancellation should update semantic status and produce diagnostics consistent with existing output-channel patterns. They should not hide baseline index results or make commands appear successful with silently fabricated metadata.

Activation and baseline search must not wait for semantic enrichment. Background work should yield regularly, honor rebuild cancellation, and avoid rewriting stale metadata after index generations change.

## Testing Strategy

Testing should cover correctness and responsiveness regressions.

### Correctness

- Provider bridge wrappers for each VS Code command.
- Enrichment updates for successful provider calls.
- Failure, timeout, and cancellation status handling.
- Persistence serialization, restoration, and compatibility invalidation.
- Provider-first command behavior after enrichment exists.
- Approximate fallback labels and ranking.

### Responsiveness

Add regression tests that simulate:

- slow providers,
- provider failures,
- large symbol sets,
- cancellation during rebuild,
- repeated quick-pick narrowing while enrichment is in flight.

Assertions should verify that semantic enrichment does not block activation, does not delay baseline indexed results, respects concurrency and timeout settings, and preserves provider-first ranking once enriched data arrives.

## Delivery Notes

Start with semantic metadata and ranking improvements before adding new commands. That keeps the first implementation focused, measurable, and compatible with the existing command-search architecture.
