## Context

The extension currently filters indexable paths using a combination of built-in heavy-path exclusions and the `fastIndexer.exclude` glob setting. That model is simple but limited: users cannot share ignore intent through a file, cannot express familiar `.gitignore`-style rules, and cannot cleanly manage ignore rules across mixed single-root and multi-root workspaces.

This change needs to affect both initial indexing and incremental watcher behavior, and it also needs to interact with the new persistence layer so cached snapshots are not reused when ignore behavior changes. The design therefore needs one consistent ignore-resolution path rather than separate ad hoc filters.

## Goals / Non-Goals

**Goals:**
- Preserve `fastIndexer.exclude` while adding file-based ignore support.
- Support `.gitignore`-style rule parsing from configured ignore-file paths.
- Support both per-workspace-folder and shared workspace-level ignore-file resolution in multi-root workspaces.
- Use one merged ignore matcher for initial discovery, watcher filtering, and persistence invalidation.
- Keep missing or unreadable ignore files non-fatal.

**Non-Goals:**
- Reading every `.gitignore` file in the workspace automatically.
- Replacing existing include/exclude settings with a file-only model.
- Exposing a user-facing ignore-rule editor or management UI.
- Implementing arbitrary VCS ignore semantics beyond the configured ignore-file inputs.

## Decisions

### Decision: Use a layered ignore engine fed by settings and configured files

The extension will continue to honor built-in heavy-path exclusions and `fastIndexer.exclude`, then merge those with rules loaded from configured ignore files into one normalized matcher. This keeps current behavior stable for existing users while enabling richer path definitions.

**Alternatives considered:**
- **Ignore-file-only model:** cleaner conceptual model, but too disruptive given the existing settings surface.
- **Separate matcher paths for indexing vs watching:** lower short-term change cost, but risks inconsistent filtering behavior.

### Decision: Add configured ignore-file path entries instead of auto-reading `.gitignore`

Ignore files will be opt-in via settings, and their contents will be parsed with `.gitignore`-style semantics. This gives users familiar rule syntax without implicitly coupling indexing behavior to all repository ignore files.

**Alternatives considered:**
- **Read `.gitignore` files directly:** convenient for some repos, but unpredictable and potentially too broad for an indexer-specific feature.
- **Dedicated custom syntax:** simpler to implement, but weaker ergonomics and lower compatibility with user expectations.

### Decision: Support both per-folder and shared path resolution for multi-root workspaces

Configured ignore-file paths need to cover two common cases: a repeated path inside each workspace folder and a shared path used across the overall workspace setup. The design should therefore allow both forms and resolve them into per-folder rule sets before matching.

**Alternatives considered:**
- **Per-folder only:** simple, but too restrictive for shared workspace configurations.
- **Shared only:** simpler state model, but mismatched with multi-root folder-local ignore needs.

### Decision: Include effective ignore configuration in persistence invalidation

Warm-start snapshots must be invalidated when ignore settings or resolved ignore-rule inputs change. The persistence metadata should therefore fingerprint the effective ignore-related configuration alongside existing indexing metadata.

**Alternatives considered:**
- **Ignore persistence invalidation for ignore changes:** simpler, but would allow stale cached indexes to surface paths that are now ignored.
- **Disable persistence whenever ignore files are configured:** safe but unnecessarily pessimistic.

## Risks / Trade-offs

- **[Rule-merging complexity]** Combining built-in excludes, glob settings, and ignore-file rules can create subtle precedence behavior → **Mitigation:** define one precedence model explicitly and test merged cases.
- **[Multi-root ambiguity]** Supporting both per-folder and shared ignore-file paths increases configuration complexity → **Mitigation:** keep the setting shape explicit and document path resolution clearly.
- **[Watcher churn]** Ignore-file edits may trigger rebuilds more often than ordinary config changes → **Mitigation:** debounce refresh behavior through the existing rebuild queue.
- **[Parser expectations]** Users may assume full Git behavior, including unsupported edge cases → **Mitigation:** scope the feature explicitly as `.gitignore`-style semantics for configured files, not full Git parity.
