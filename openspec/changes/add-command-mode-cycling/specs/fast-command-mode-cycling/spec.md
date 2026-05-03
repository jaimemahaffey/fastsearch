## ADDED Requirements

### Requirement: Unified fast command entry point SHALL cycle through search modes
The system SHALL provide a unified fast indexer command that cycles through symbol, text, and file search modes in that order when invoked repeatedly during an active cycle session.

#### Scenario: First invocation starts in symbol mode
- **WHEN** the user invokes the unified fast command without an active cycle session
- **THEN** the command SHALL open in symbol mode

#### Scenario: Repeated invocation advances the mode
- **WHEN** the user invokes the unified fast command again while the cycle session is still active
- **THEN** the command SHALL advance from symbol to text, from text to file, and from file back to symbol

### Requirement: Active cycle mode SHALL be visible in the command UI
The system SHALL make the active search mode visible while the unified fast command is open so users can tell whether they are searching symbols, text, or files.

#### Scenario: Mode indicator updates with cycling
- **WHEN** the active mode changes during a cycle session
- **THEN** the command UI SHALL update its placeholder, title, or equivalent visible label to reflect the new mode

### Requirement: Cycle sessions SHALL reset predictably
The system SHALL reset the unified fast command back to its initial symbol mode when the active cycle session ends.

#### Scenario: Next fresh invocation resets to symbol mode
- **WHEN** the current cycle session ends because the picker is accepted, cancelled, or otherwise reset
- **THEN** the next invocation of the unified fast command SHALL start in symbol mode

### Requirement: Dedicated mode-specific commands SHALL remain available
The system SHALL preserve the existing dedicated file, text, and symbol commands while adding the unified cycling command.

#### Scenario: Direct command access remains supported
- **WHEN** a user invokes a dedicated fast symbol, text, or file command directly
- **THEN** that command SHALL continue to run its corresponding mode without requiring the unified cycling entry point
