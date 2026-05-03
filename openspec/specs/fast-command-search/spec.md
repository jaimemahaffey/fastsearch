# fast-command-search Specification

## Requirements

### Requirement: Fast indexer commands SHALL support fuzzy-ranked matching
The system SHALL rank command candidates using fuzzy matching so users can find files, text results, symbols, usages, and implementations from partial or non-contiguous input instead of relying only on direct substring matches.

#### Scenario: Partial query still finds relevant candidates
- **WHEN** a user enters an incomplete or abbreviated query for a fast indexer command
- **THEN** the command SHALL return ranked results that include relevant candidates matched by fuzzy logic

#### Scenario: Better-ranked candidate appears first
- **WHEN** multiple command candidates match the same fuzzy query with different strengths
- **THEN** the command SHALL order the stronger fuzzy match ahead of weaker matches

### Requirement: Fast indexer commands SHALL present completion-style interactive results
The system SHALL present command results in a completion-engine-style flow that updates interactively as input narrows intent and preserves meaningful labels, previews, or metadata for selection.

#### Scenario: Result list narrows during input refinement
- **WHEN** a user continues typing into a fast indexer command search flow
- **THEN** the visible candidate list SHALL update to reflect the refined query without requiring the command to restart

#### Scenario: Results include useful selection context
- **WHEN** a command presents ranked candidates to the user
- **THEN** each candidate SHALL include enough context to distinguish similar matches, such as path, preview text, symbol container, or match type

### Requirement: External search tools SHALL be optional accelerators
The system SHALL allow optional use of external tools such as `rg` and `fzf` to accelerate candidate gathering or interactive narrowing, but it SHALL continue to function when those tools are unavailable, disabled, or fail.

#### Scenario: External provider available and enabled
- **WHEN** a command is configured to use an external search provider and the required binary is available
- **THEN** the command SHALL be allowed to use that provider to gather or refine candidates

#### Scenario: External provider unavailable
- **WHEN** a configured external provider is missing or returns an error
- **THEN** the command SHALL fall back to the built-in search path without failing the command

### Requirement: External-provider usage SHALL be configurable
The system SHALL expose configuration that controls whether optional external providers participate in fast command search behavior.

#### Scenario: External provider disabled by configuration
- **WHEN** a user disables external search-provider usage in settings
- **THEN** fast indexer commands SHALL use only the built-in search path for that capability

#### Scenario: Command behavior remains predictable across environments
- **WHEN** two environments differ in whether `rg` or `fzf` is installed
- **THEN** the extension SHALL preserve the same command entry points and fall back behavior, with only the configured acceleration path changing
