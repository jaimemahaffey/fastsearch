# Tasks

## 1. Reconcile change scope

- [x] Update the change narrative so `fast-symbol-indexer` describes the remaining base-capability questions rather than the already-implemented bootstrap work.
- [x] Keep later completed changes, such as fuzzy completion search and command mode cycling, out of this umbrella change's scope.

## 2. Persistence policy

- [x] Decide whether persistence is unsupported, internal-only, or an explicit supported feature of the base capability.
- [x] Update the relevant artifacts to match that persistence decision.

## 3. Multi-root semantics

- [x] Decide how workspace identity should be defined for multi-root workspaces.
- [x] Clarify how cache and rebuild behavior should respond when the workspace folder set changes.

## 4. Validation and language

- [x] Clarify how approximate fallback results should be described in the base capability language.
- [x] Identify any tests or follow-on tasks that are needed once persistence and multi-root behavior are explicitly decided.
