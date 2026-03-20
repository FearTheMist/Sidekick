import * as vscode from "vscode";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ApiMode = "auto" | "chatCompletions" | "responses";
type StringMap = Record<string, string>;
type UnknownMap = Record<string, unknown>;

let chatView: vscode.WebviewView | undefined;
let settingsPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const chatViewProvider = vscode.window.registerWebviewViewProvider("sidekick.chatView", {
    resolveWebviewView(webviewView) {
      chatView = webviewView;
      webviewView.webview.options = {
        enableScripts: true
      };
      webviewView.webview.html = getWebviewHtml();
      registerChatMessageHandler(webviewView.webview, context);

      webviewView.onDidDispose(() => {
        chatView = undefined;
      });
    }
  });

  const configureModelCommand = vscode.commands.registerCommand("sidekick.configureModel", async () => {
    await openSettingsPanel(context);
  });

  const openSettingsCommand = vscode.commands.registerCommand("sidekick.openSettings", async () => {
    await openSettingsPanel(context);
  });

  const openChatCommand = vscode.commands.registerCommand("sidekick.openChat", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.sidekick");
    chatView?.show(false);
  });

  context.subscriptions.push(chatViewProvider);
  context.subscriptions.push(openChatCommand);
  context.subscriptions.push(configureModelCommand);
  context.subscriptions.push(openSettingsCommand);
}

export function deactivate(): void {
  // No-op
}

function registerChatMessageHandler(webview: vscode.Webview, context: vscode.ExtensionContext): void {
  webview.onDidReceiveMessage(
    async (message: { type: string; text?: string; history?: ChatMessage[] }) => {
      if (message.type === "configure") {
        await vscode.commands.executeCommand("sidekick.configureModel");
        return;
      }

      if (message.type !== "send") {
        return;
      }

      const userText = (message.text ?? "").trim();
      const history = Array.isArray(message.history) ? message.history : [];

      if (!userText) {
        webview.postMessage({ type: "error", text: "Message cannot be empty." });
        return;
      }

      try {
        webview.postMessage({ type: "assistantStart" });
        const reply = await requestChatCompletion(userText, history, (delta) => {
          webview.postMessage({ type: "assistantDelta", text: delta });
        });
        webview.postMessage({ type: "assistantDone", text: reply });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : "Unknown error";
        webview.postMessage({ type: "error", text: errorText });
      }
    },
    undefined,
    context.subscriptions
  );
}

async function openSettingsPanel(context: vscode.ExtensionContext): Promise<void> {
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
    systemPrompt: config.get<string>("systemPrompt", "You are a helpful coding assistant.")
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

  if (!apiBaseUrl) {
    throw new Error("API Base URL is required.");
  }

  if (!model) {
    throw new Error("Model is required.");
  }

  if (apiMode !== "auto" && apiMode !== "chatCompletions" && apiMode !== "responses") {
    throw new Error("Invalid API mode.");
  }

  parseUnknownJsonObject(extraHeadersJson, "sidekick.extraHeadersJson");
  parseUnknownJsonObject(extraBodyJson, "sidekick.extraBodyJson");

  await config.update("apiBaseUrl", apiBaseUrl, vscode.ConfigurationTarget.Global);
  await config.update("model", model, vscode.ConfigurationTarget.Global);
  await config.update("apiMode", apiMode, vscode.ConfigurationTarget.Global);
  await config.update("promptCacheKey", promptCacheKey, vscode.ConfigurationTarget.Global);
  await config.update("extraHeadersJson", extraHeadersJson, vscode.ConfigurationTarget.Global);
  await config.update("extraBodyJson", extraBodyJson, vscode.ConfigurationTarget.Global);
  await config.update("systemPrompt", systemPrompt || "You are a helpful coding assistant.", vscode.ConfigurationTarget.Global);
  await config.update("apiKey", apiKey, vscode.ConfigurationTarget.Global);
}

async function requestChatCompletion(
  userText: string,
  history: ChatMessage[],
  onDelta: (delta: string) => void
): Promise<string> {
  const config = vscode.workspace.getConfiguration("sidekick");
  const apiBaseUrl = config.get<string>("apiBaseUrl", "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = config.get<string>("apiKey", "").trim();
  const model = config.get<string>("model", "gpt-4o-mini");
  const promptCacheKey = config.get<string>("promptCacheKey", "").trim();
  const extraHeadersJson = config.get<string>("extraHeadersJson", "{}");
  const extraBodyJson = config.get<string>("extraBodyJson", "{}");
  const apiMode = config.get<ApiMode>("apiMode", "auto");
  const systemPrompt = config.get<string>("systemPrompt", "You are a helpful coding assistant.");

  const extraHeaders = parseStringJsonObject(extraHeadersJson, "sidekick.extraHeadersJson");
  const extraBody = parseUnknownJsonObject(extraBodyJson, "sidekick.extraBodyJson");

  if (!apiKey) {
    throw new Error("Please set sidekick.apiKey in VS Code settings.");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.filter((item) => item.role !== "system"),
    { role: "user", content: userText }
  ];

  if (model.toLowerCase().includes("gpt-5.3-codex") && !promptCacheKey) {
    throw new Error("This model requires sidekick.promptCacheKey. Please run 'Sidekick: Configure Model' and set it.");
  }

  if (apiMode === "chatCompletions") {
    return await callChatCompletions(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
  }

  if (apiMode === "responses") {
    return await callResponsesApi(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
  }

  try {
    return await callChatCompletions(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
  } catch (error) {
    if (shouldFallbackToResponses(error)) {
      return await callResponsesApi(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
    }
    throw error;
  }
}

async function callChatCompletions(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  promptCacheKey: string,
  onDelta: (delta: string) => void,
  extraHeaders: StringMap,
  extraBody: UnknownMap
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true
  };

  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
  }

  Object.assign(body, extraBody);

  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(formatApiError(response.status, body));
  }

  if (isEventStreamResponse(response)) {
    return await readSseResponse(response, onDelta);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("The model returned an empty response.");
  }

  return content;
}

async function callResponsesApi(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  promptCacheKey: string,
  onDelta: (delta: string) => void,
  extraHeaders: StringMap,
  extraBody: UnknownMap
): Promise<string> {
  const input = messages.map((item) => ({
    role: item.role,
    content: [
      {
        type: "input_text",
        text: item.content
      }
    ]
  }));

  const body: Record<string, unknown> = {
    model,
    input,
    stream: true
  };

  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
  }

  Object.assign(body, extraBody);

  const response = await fetch(`${apiBaseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(formatApiError(response.status, body));
  }

  if (isEventStreamResponse(response)) {
    return await readSseResponse(response, onDelta);
  }

  const data = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  const directText = data.output_text?.trim();
  if (directText) {
    return directText;
  }

  for (const chunk of data.output ?? []) {
    for (const content of chunk.content ?? []) {
      if (content.type === "output_text" && content.text?.trim()) {
        return content.text.trim();
      }
    }
  }

  throw new Error("The model returned an empty response.");
}

function shouldFallbackToResponses(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return lower.includes("responses api") || lower.includes("/v1/responses") || lower.includes("/responses");
}

function formatApiError(status: number, body: string): string {
  return `LLM request failed (${status}): ${body}`;
}

function parseUnknownJsonObject(raw: string, settingKey: string): UnknownMap {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must be a JSON object");
    }
    return value as UnknownMap;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${settingKey} ${message}`);
  }
}

function parseStringJsonObject(raw: string, settingKey: string): StringMap {
  const parsed = parseUnknownJsonObject(raw, settingKey);
  const headers: StringMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (value !== null && value !== undefined) {
      headers[key] = String(value);
    }
  }
  return headers;
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}

async function readSseResponse(response: Response, onDelta: (delta: string) => void): Promise<string> {
  if (!response.body) {
    throw new Error("Streaming response has no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (dataLines.length === 0) {
        continue;
      }

      const payload = dataLines.join("\n");
      if (payload === "[DONE]") {
        continue;
      }

      const delta = extractDeltaText(payload);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error("The model returned an empty response.");
  }

  return fullText;
}

function extractDeltaText(payload: string): string {
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;

    if (typeof data.delta === "string") {
      return data.delta;
    }

    const choices = data.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const delta = first.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === "string") {
        return delta.content;
      }
    }

    const itemType = data.type;
    if (itemType === "response.output_text.delta" && typeof data.delta === "string") {
      return data.delta;
    }

    return "";
  } catch {
    return "";
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
      systemPrompt: document.getElementById("systemPrompt")
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

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sidekick Chat</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    #toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #title {
      font-size: 12px;
      opacity: 0.85;
      letter-spacing: 0.2px;
    }
    #configure {
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    #configure:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      max-width: 90%;
      padding: 10px 12px;
      border-radius: 10px;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .assistant {
      align-self: flex-start;
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .error {
      align-self: center;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    #composer {
      display: flex;
      padding: 12px;
      gap: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    #input {
      flex: 1;
      min-height: 38px;
      max-height: 150px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 8px;
      padding: 8px;
      font-family: inherit;
    }
    #send {
      border: none;
      border-radius: 8px;
      padding: 0 16px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #send:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <div id="title">Sidekick Chat</div>
    <button id="configure">Configure</button>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <textarea id="input" placeholder="Ask anything about code..."></textarea>
    <button id="send">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendEl = document.getElementById("send");
    const configureEl = document.getElementById("configure");
    const history = [];

    function pushMessage(role, text) {
      const item = document.createElement("div");
      item.className = "msg " + role;
      item.textContent = text;
      messagesEl.appendChild(item);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) {
        return;
      }

      history.push({ role: "user", content: text });
      pushMessage("user", text);
      inputEl.value = "";
      sendEl.disabled = true;

      vscode.postMessage({ type: "send", text, history });
    }

    sendEl.addEventListener("click", sendMessage);
    configureEl.addEventListener("click", () => {
      vscode.postMessage({ type: "configure" });
    });
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    window.addEventListener("message", (event) => {
      const data = event.data;

      if (data.type === "assistantStart") {
        if (!window.__sidekickActiveAssistantEl) {
          const item = document.createElement("div");
          item.className = "msg assistant";
          item.textContent = "";
          messagesEl.appendChild(item);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          window.__sidekickActiveAssistantEl = item;
        }
      }

      if (data.type === "assistantDelta") {
        if (!window.__sidekickActiveAssistantEl) {
          const item = document.createElement("div");
          item.className = "msg assistant";
          item.textContent = "";
          messagesEl.appendChild(item);
          window.__sidekickActiveAssistantEl = item;
        }

        window.__sidekickActiveAssistantEl.textContent += data.text;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      if (data.type === "assistantDone") {
        const finalText = (data.text || "").trim();
        if (window.__sidekickActiveAssistantEl) {
          if (!window.__sidekickActiveAssistantEl.textContent && finalText) {
            window.__sidekickActiveAssistantEl.textContent = finalText;
          }
        } else if (finalText) {
          pushMessage("assistant", finalText);
        }

        if (finalText) {
          history.push({ role: "assistant", content: finalText });
        }

        window.__sidekickActiveAssistantEl = null;
        sendEl.disabled = false;
        inputEl.focus();
      }

      if (data.type === "error") {
        if (window.__sidekickActiveAssistantEl && !window.__sidekickActiveAssistantEl.textContent) {
          window.__sidekickActiveAssistantEl.remove();
        }
        window.__sidekickActiveAssistantEl = null;
        pushMessage("error", data.text);
        sendEl.disabled = false;
        inputEl.focus();
      }
    });
  </script>
</body>
</html>`;
}
