import * as vscode from "vscode";

type ApiMode = "auto" | "chatCompletions" | "responses";

let settingsPanel: vscode.WebviewPanel | undefined;

export async function openSettingsPanel(context: vscode.ExtensionContext): Promise<void> {
  if (settingsPanel) {
    settingsPanel.reveal(vscode.ViewColumn.Active);
    settingsPanel.webview.postMessage({ type: "init", settings: getCurrentSettings() });
    return;
  }

  settingsPanel = vscode.window.createWebviewPanel("sidekickSettings", "Sidekick Settings", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  settingsPanel.webview.html = getSettingsWebviewHtml();

  settingsPanel.webview.onDidReceiveMessage(
    async (message: { type: string; settings?: Record<string, string> }) => {
      if (message.type === "ready") {
        settingsPanel?.webview.postMessage({ type: "init", settings: getCurrentSettings() });
        return;
      }

      if (message.type !== "save" || !message.settings) {
        return;
      }

      try {
        await saveSettings(message.settings);
        settingsPanel?.webview.postMessage({ type: "saved" });
        vscode.window.showInformationMessage("Sidekick settings saved.");
      } catch (error) {
        const text = error instanceof Error ? error.message : "Failed to save settings.";
        settingsPanel?.webview.postMessage({ type: "error", text });
      }
    },
    undefined,
    context.subscriptions
  );

  settingsPanel.onDidDispose(() => {
    settingsPanel = undefined;
  });
}

function getCurrentSettings(): Record<string, string> {
  const config = vscode.workspace.getConfiguration("sidekick");
  return {
    apiBaseUrl: config.get<string>("apiBaseUrl", "https://api.openai.com/v1"),
    apiKey: config.get<string>("apiKey", ""),
    model: config.get<string>("model", "gpt-4o-mini"),
    apiMode: config.get<ApiMode>("apiMode", "auto"),
    promptCacheKey: config.get<string>("promptCacheKey", ""),
    extraHeadersJson: config.get<string>("extraHeadersJson", "{}"),
    extraBodyJson: config.get<string>("extraBodyJson", "{}"),
    systemPrompt: config.get<string>("systemPrompt", "You are a helpful coding assistant."),
    commitMessagePrompt: config.get<string>(
      "commitMessagePrompt",
      "You are an expert software engineer writing concise git commit messages. Match the repository's existing commit style, focus on intent, and return only the commit message text."
    )
  };
}

async function saveSettings(settings: Record<string, string>): Promise<void> {
  const config = vscode.workspace.getConfiguration("sidekick");
  const apiBaseUrl = (settings.apiBaseUrl ?? "").trim();
  const model = (settings.model ?? "").trim();
  const apiMode = (settings.apiMode ?? "auto").trim() as ApiMode;
  const promptCacheKey = (settings.promptCacheKey ?? "").trim();
  const extraHeadersJson = (settings.extraHeadersJson ?? "{}").trim() || "{}";
  const extraBodyJson = (settings.extraBodyJson ?? "{}").trim() || "{}";
  const systemPrompt = (settings.systemPrompt ?? "").trim();
  const apiKey = (settings.apiKey ?? "").trim();
  const commitMessagePrompt = (settings.commitMessagePrompt ?? "").trim();

  if (!apiBaseUrl) {
    throw new Error("API Base URL is required.");
  }

  if (!model) {
    throw new Error("Model is required.");
  }

  if (apiMode !== "auto" && apiMode !== "chatCompletions" && apiMode !== "responses") {
    throw new Error("Invalid API mode.");
  }

  parseJsonObject(extraHeadersJson, "sidekick.extraHeadersJson");
  parseJsonObject(extraBodyJson, "sidekick.extraBodyJson");

  await config.update("apiBaseUrl", apiBaseUrl, vscode.ConfigurationTarget.Global);
  await config.update("model", model, vscode.ConfigurationTarget.Global);
  await config.update("apiMode", apiMode, vscode.ConfigurationTarget.Global);
  await config.update("promptCacheKey", promptCacheKey, vscode.ConfigurationTarget.Global);
  await config.update("extraHeadersJson", extraHeadersJson, vscode.ConfigurationTarget.Global);
  await config.update("extraBodyJson", extraBodyJson, vscode.ConfigurationTarget.Global);
  await config.update("systemPrompt", systemPrompt || "You are a helpful coding assistant.", vscode.ConfigurationTarget.Global);
  await config.update("apiKey", apiKey, vscode.ConfigurationTarget.Global);
  await config.update(
    "commitMessagePrompt",
    commitMessagePrompt ||
      "You are an expert software engineer writing concise git commit messages. Match the repository's existing commit style, focus on intent, and return only the commit message text.",
    vscode.ConfigurationTarget.Global
  );
}

function parseJsonObject(raw: string, settingKey: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${settingKey} ${message}`);
  }
}

function getSettingsWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sidekick Settings</title>
  <style>
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, sans-serif;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    .wrap {
      max-width: 840px;
      margin: 0 auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 600;
    }
    .desc {
      margin: 0;
      opacity: 0.85;
      font-size: 12px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    label {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    input,
    select,
    textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 8px;
      padding: 8px 10px;
      font-family: inherit;
      font-size: 13px;
    }
    textarea {
      min-height: 90px;
      resize: vertical;
    }
    .actions {
      margin-top: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    button {
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    #status {
      font-size: 12px;
      opacity: 0.9;
    }
    .ok {
      color: var(--vscode-terminal-ansiGreen);
    }
    .err {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>Sidekick Settings</h1>
    <p class="desc">Configure API key, model, routing mode and request parameters in one place.</p>

    <div class="field">
      <label for="apiBaseUrl">API Base URL</label>
      <input id="apiBaseUrl" type="text" placeholder="https://api.openai.com/v1" />
    </div>

    <div class="field">
      <label for="apiKey">API Key</label>
      <input id="apiKey" type="password" placeholder="sk-..." />
    </div>

    <div class="field">
      <label for="model">Model</label>
      <input id="model" type="text" placeholder="gpt-4o-mini" />
    </div>

    <div class="field">
      <label for="apiMode">API Mode</label>
      <select id="apiMode">
        <option value="auto">Auto</option>
        <option value="chatCompletions">Chat Completions</option>
        <option value="responses">Responses</option>
      </select>
    </div>

    <div class="field">
      <label for="promptCacheKey">Prompt Cache Key</label>
      <input id="promptCacheKey" type="text" placeholder="Optional" />
    </div>

    <div class="field">
      <label for="extraHeadersJson">Extra Headers JSON</label>
      <textarea id="extraHeadersJson" placeholder='{"x-provider-key":"value"}'></textarea>
    </div>

    <div class="field">
      <label for="extraBodyJson">Extra Body JSON</label>
      <textarea id="extraBodyJson" placeholder='{"reasoning":{"effort":"medium"}}'></textarea>
    </div>

    <div class="field">
      <label for="systemPrompt">System Prompt</label>
      <textarea id="systemPrompt" placeholder="You are a helpful coding assistant."></textarea>
    </div>

    <div class="field">
      <label for="commitMessagePrompt">Commit Message Prompt</label>
      <textarea id="commitMessagePrompt" placeholder="Prompt for generating commit messages..."></textarea>
    </div>

    <div class="actions">
      <button id="save">Save Settings</button>
      <span id="status"></span>
    </div>
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    const fields = {
      apiBaseUrl: document.getElementById("apiBaseUrl"),
      apiKey: document.getElementById("apiKey"),
      model: document.getElementById("model"),
      apiMode: document.getElementById("apiMode"),
      promptCacheKey: document.getElementById("promptCacheKey"),
      extraHeadersJson: document.getElementById("extraHeadersJson"),
      extraBodyJson: document.getElementById("extraBodyJson"),
      systemPrompt: document.getElementById("systemPrompt"),
      commitMessagePrompt: document.getElementById("commitMessagePrompt")
    };
    const statusEl = document.getElementById("status");
    const saveEl = document.getElementById("save");

    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = cls || "";
    }

    function fillForm(settings) {
      for (const [key, value] of Object.entries(settings || {})) {
        if (fields[key]) {
          fields[key].value = value || "";
        }
      }
    }

    saveEl.addEventListener("click", () => {
      setStatus("Saving...", "");
      const payload = {};
      for (const [key, element] of Object.entries(fields)) {
        payload[key] = element.value || "";
      }
      vscode.postMessage({ type: "save", settings: payload });
    });

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data.type === "init") {
        fillForm(data.settings || {});
        setStatus("", "");
      }
      if (data.type === "saved") {
        setStatus("Settings saved.", "ok");
      }
      if (data.type === "error") {
        setStatus(data.text || "Failed to save settings.", "err");
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
