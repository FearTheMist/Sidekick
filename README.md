# Sidekick (VS Code Extension)

This is a minimal first-step scaffold for a Copilot/Cline-like extension:

- VS Code extension project initialization
- Configurable LLM settings
- Chat panel UI in a Webview
- Round-trip chat requests to a Chat Completions-compatible API

## 1) Install dependencies

```bash
npm install
```

## 2) Build the extension

```bash
npm run compile
```

## 3) Run in Extension Development Host

1. Open this project in VS Code.
2. Press `F5` (or run `Run Sidekick` in Debug panel).
3. In the new Extension Development Host window, run command:
   `Sidekick: Open Chat`

## 4) Configure your model

You can configure in two ways:

1. Run command `Sidekick: Configure Model` (recommended).
2. Or edit Sidekick settings manually.

In VS Code settings, search `Sidekick` and set:

- `sidekick.apiBaseUrl` (default: `https://api.openai.com/v1`)
- `sidekick.apiKey`
- `sidekick.model`
- `sidekick.promptCacheKey` (required by some routed/custom models)
- `sidekick.extraHeadersJson` (JSON object, optional)
- `sidekick.extraBodyJson` (JSON object, optional, for provider-specific required params)
- `sidekick.apiMode` (`auto` | `chatCompletions` | `responses`)
- `sidekick.systemPrompt`

You can also put them in `settings.json`:

```json
{
  "sidekick.apiBaseUrl": "https://api.openai.com/v1",
  "sidekick.apiKey": "<YOUR_API_KEY>",
  "sidekick.model": "gpt-4o-mini",
  "sidekick.promptCacheKey": "<OPTIONAL_CACHE_KEY>",
  "sidekick.extraHeadersJson": "{}",
  "sidekick.extraBodyJson": "{}",
  "sidekick.apiMode": "auto",
  "sidekick.systemPrompt": "You are a helpful coding assistant."
}
```

## Notes

- Current request format targets OpenAI-compatible `/chat/completions`.
- Sidekick now supports SSE streaming and sends `stream: true` for providers that require streaming mode.
- Sidekick no longer sends `temperature` by default to avoid strict-provider validation failures.
- This is the first-step foundation; next you can add context injection, streaming responses, code actions, and tool calling.
