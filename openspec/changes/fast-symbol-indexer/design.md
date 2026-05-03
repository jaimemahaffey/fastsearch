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

The design needs to answer:

- Is identity based on the first workspace folder?
- Is identity based on the full ordered set of workspace folders?
- Is identity based on the `.code-workspace` file when one exists?
- What should happen when the set of folders changes?

### Current Lean

The most future-proof answer is to treat workspace identity as a property of the **entire workspace composition**, not only the first folder.

Even if the current implementation remains simpler for now, the design should make the intended semantics explicit.

## 3. Approximate-Result Language

The base capability already prefers semantic provider results where available and falls back to local index approximations when needed.

What remains is not the mechanism but the language:

- when should fallback results be shown,
- how visibly should they be marked,
- and how should the base capability describe the difference between semantic and approximate answers?

### Current Lean

Keep the distinction explicit wherever fallback results are shown. The base capability should avoid overstating semantic confidence.

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

- What exact workspace identity model should the base capability promise?
- Does the spec need stronger language around how approximate fallback results are labeled?
