# Changelog

All notable changes to this project will be documented in this file.

## [0.0.7] - 2026-04-22

### Added
- Added a unified `Sidekick Control Center` for Providers, MCP, Permissions, and General settings.
- Added permission policy management for terminal command categories, including read, project execution, project mutation, external access, network access, and high-risk commands.
- Added session permission clearing from the control center.

### Changed
- Changed terminal command authorization from a single coarse permission to graded authorization by command category and scope.
- Changed the control center layout to top tabs to give configuration forms more horizontal space.
- Changed provider and MCP `Enabled` fields from dropdowns to toggle controls.
- Changed model endpoint type options in the control center to `OPENAI`, `OPENAI_RESPONSE`, and `ANTHROPIC_MESSAGES` only, with legacy compatible variants normalized on save.
- Changed general commit message language setting to save immediately on selection.

### Fixed
- Fixed MCP creation flow so new servers are first created as editable drafts instead of failing immediately on empty configuration.
- Fixed duplicated commit message language settings by keeping the setting only in the General section.

## [0.0.4] - 2026-04-15

### Added
- Added multi-session chat with persistent session history.
- Added a session list view with create, switch, and delete actions.
- Added automatic title generation for new chat sessions.
- Added raw message and message-part inspection in the chat panel.
- Added API key visibility toggle in settings.

### Changed
- Updated the chat panel to support per-session provider and model selection.
- Updated chat navigation to switch between chat and session list views.
- Updated the README to reflect current chat capabilities.
- Updated chat action buttons to use icon-only controls.

### Fixed
- Fixed chat view restoration when reopening the Sidekick sidebar.
- Fixed send button initialization after reopening the chat panel.
- Fixed auto-scroll behavior while streaming and finalizing assistant responses.
- Fixed message action icon styling in chat bubbles.
