# Sidekick

Sidekick is a VS Code AI coding assistant focused on three things: sidebar chat, inline completion, and editor actions that turn a code selection into a concrete task.

It is designed for teams that want to connect their own model providers instead of being locked to a single hosted backend.

## What Sidekick Does

- Adds a dedicated Sidekick chat panel to the VS Code activity bar
- Provides inline code completion inside the editor
- Lets you send selected code to AI actions such as explain, refactor, bug fixing, test generation, and documentation
- Generates commit message drafts from your Git changes
- Supports multiple LLM provider types through configuration
- Supports MCP server configuration for tool-enabled agent workflows

## Core Features

### Sidebar Chat

Open the Sidekick panel from the activity bar to chat with the configured model.

The chat flow includes:

- workspace and editor context collection
- provider and model selection
- persistent chat history
- export and clear actions
- settings entry from the panel

### Inline Completion

Sidekick can stream inline suggestions directly in the editor.

It is built for lightweight coding assistance with:

- debounced requests
- cached suggestions
- streaming completions
- partial accept and reject commands

### Selection-Based Actions

From the editor context menu, you can send the current selection to Sidekick and quickly start common tasks:

- Explain Code
- Refactor
- Fix Bugs
- Add Tests
- Document

### Commit Message Generation

Sidekick adds a Git-aware commit message action so you can draft commit messages from the current repository changes.

## Supported Provider Types

Sidekick currently supports configuring providers for:

- `openai-chat`
- `openai-responses`
- `openai-compatible`
- `anthropic-messages`

Provider settings are stored in `sidekick.providers`.

## Configuration

Sidekick exposes several settings in VS Code:

- `sidekick.providers`: configured model providers
- `sidekick.completionProfile`: model profile used for inline completion
- `sidekick.chatProfile`: model profile used for chat
- `sidekick.agentProfile`: model profile used for agent and tool calls
- `sidekick.mcpServers`: MCP server definitions

## Commands

Sidekick contributes the following commands:

- `Sidekick: Open Chat`
- `Sidekick: Open Settings`
- `Sidekick: Explain Code`
- `Sidekick: Refactor`
- `Sidekick: Fix Bugs`
- `Sidekick: Add Tests`
- `Sidekick: Document`
- `Sidekick: Generate Commit Message`
- `Sidekick: Test Provider Connection`
- `Sidekick: Open Inline Logs`

## Quick Start

1. Install the extension.
2. Open VS Code settings JSON.
3. Configure at least one entry in `sidekick.providers`.
4. Set the model you want to use in `sidekick.chatProfile` and `sidekick.completionProfile`.
5. Open the Sidekick panel from the activity bar and start chatting.

## Development

To run the extension locally:

1. Install dependencies.
2. Run `npm run compile`.
3. Launch the extension in the VS Code Extension Development Host.

