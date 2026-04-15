# Changelog

All notable changes to this project will be documented in this file.

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
