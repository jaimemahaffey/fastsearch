# Design Notes

## Current State

The base fast indexer capability is already present in the codebase:

- extension activation and command registration exist,
- file, text, and symbol indexes exist,
- watcher-driven incremental updates exist,
- navigation and discovery commands exist,
- and later follow-on changes have already extended the capability with fuzzy completion behavior, optional external search tooling, and mode cycling.

This design document is therefore no longer about inventing the architecture from scratch. It is about deciding the last operational semantics that still feel underspecified at the base-capability level.

## Design Focus

The remaining design work is concentrated in three areas:

1. **Persistence policy**
2. **Multi-root workspace identity**
3. **Approximate-result language**

## 1. Persistence Policy

There is already persistence-related scaffolding in the implementation, but the user-facing product stance is not clearly defined.

The design considered three possibilities:

- **Ephemeral-only:** indexes are rebuilt per session and persistence is not part of the supported feature surface.
- **Internal cache only:** persistence may exist as an implementation detail, but users do not configure or rely on it.
- **Supported configurable behavior:** persistence becomes an explicit capability with settings, validation, and lifecycle guarantees.

### Decision

The base capability will treat persistence as **internal cache only**.

That means:

- local cached state may exist as an implementation detail,
- users should not depend on cache survival, portability, or explicit persistence guarantees,
- and persistence should not yet be presented as a configurable supported feature of the extension.

This keeps the base capability honest and avoids implying guarantees that the extension does not yet expose.

## 2. Multi-Root Workspace Identity

The extension already shows some awareness of multi-root workspaces, but the change artifacts do not clearly define what counts as “the workspace” for cache and lifecycle purposes.

### Decision

Workspace identity should be treated as a property of the **entire current workspace composition**, not only the first folder.

For design purposes that means:

- if a `.code-workspace` file is the authoritative workspace container, its identity can anchor the composition,
- otherwise identity should be derived from the ordered set of current workspace folder URIs,
- and two workspaces with the same first folder but different overall folder sets should not be treated as the same cache or lifecycle identity.

### Workspace Folder Set Changes

When the workspace folder set changes, the extension should treat the resulting composition as a new effective workspace for lifecycle purposes.

Because persistence is internal-only cache behavior:

- prior cache state does not need compatibility guarantees across different workspace compositions,
- in-memory indexes should be considered stale when the composition changes,
- and rebuild behavior should prefer correctness for the current composition over reuse of stale state.

## 3. Approximate-Result Language

The base capability already prefers semantic provider results where available and falls back to local index approximations when needed.

### Decision

The language should stay explicit:

- provider results are the preferred semantic answer when available,
- fallback results should be described as **approximate local matches**,
- and the base capability should never imply that local fallback results have the same semantic certainty as provider-backed results.

This keeps the UX honest while still allowing the local index to provide useful degraded behavior.

## 4. Validation And Follow-On Work

The remaining follow-on work should focus on the newly-set semantics rather than re-opening the already-shipped core capability.

- Add or adjust tests around workspace identity derivation if the implementation moves from first-folder identity to full-workspace-composition identity.
- Add validation that workspace folder set changes mark index state stale and trigger rebuild behavior for the new composition.
- Keep approximate-result copy aligned with the existing provider-backed vs approximate-local labeling in command-search and discovery flows.
- If persistence later becomes user-visible, open a separate change for settings, guarantees, migration, and compatibility expectations rather than expanding this narrowed base change.

## Relationship To Other Changes

This narrowed design intentionally does **not** absorb later completed changes:

- fuzzy/completion search remains covered by `add-fuzzy-completion-search`,
- command mode cycling remains covered by `add-command-mode-cycling`.

Those changes extend the base capability, but they should remain separate in OpenSpec history instead of being folded back into the umbrella design.

## Risks

- Leaving the umbrella change broad makes OpenSpec status misleading.
- Treating persistence as “implicitly supported” without a product decision invites accidental compatibility guarantees.
- Treating multi-root support as “good enough” without defining workspace identity can cause subtle cache and rebuild ambiguity later.
- Approximate fallback results can undermine trust if their confidence level is not described consistently.

## Open Questions

- Does the implementation need to move beyond first-folder workspace identity immediately, or can the design lead the code until a follow-on implementation pass is scheduled?
