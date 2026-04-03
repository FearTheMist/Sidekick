import * as vscode from "vscode";
import { SidekickConfig } from "../../core/config";
import { LlmGateway, ProviderConfig } from "../../core/llm";
import { collectContext, toContextPrompt } from "../../context/contextCollector";
import { ChatMessage, ChatStore } from "./chatStore";

type IncomingMessage =
  | { type: "ready" }
  | { type: "send"; text: string; providerId?: string; model?: string }
  | { type: "clear" }
  | { type: "export" }
  | { type: "open-settings" };

type OutgoingMessage =
  | {
      type: "history";
      history: ChatMessage[];
      providers: ProviderConfig[];
      profileProviderId: string;
      profileModel: string;
    }
  | { type: "append"; message: ChatMessage }
  | { type: "assistant-start" }
  | { type: "assistant-delta"; delta: string }
  | { type: "assistant-end" }
  | { type: "seed"; text: string };

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "sidekick.chatView";

  private view?: vscode.WebviewView;
  private readonly store: ChatStore;
  private history: ChatMessage[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly gateway: LlmGateway
  ) {
    this.store = new ChatStore(context);
    this.history = this.store.getHistory();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (raw: IncomingMessage) => {
      switch (raw.type) {
        case "ready": {
          const profile = SidekickConfig.getChatProfile();
          this.post({
            type: "history",
            history: this.history,
            providers: SidekickConfig.getProviders(),
            profileProviderId: profile.providerId,
            profileModel: profile.model || "",
          });
          break;
        }
        case "send": {
          await this.handleSend(raw.text, raw.providerId, raw.model);
          break;
        }
        case "clear": {
          this.history = [];
          await this.store.clear();
          this.post({
            type: "history",
            history: [],
            providers: SidekickConfig.getProviders(),
            profileProviderId: SidekickConfig.getChatProfile().providerId,
            profileModel: SidekickConfig.getChatProfile().model || "",
          });
          break;
        }
        case "export": {
          await this.exportHistory();
          break;
        }
        case "open-settings": {
          await vscode.commands.executeCommand("sidekick.openSettings");
          break;
        }
      }
    });
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand("sidekick.chatView.focus");
  }

  async promptAction(action: string): Promise<void> {
    await this.focus();
    this.post({ type: "seed", text: action });
  }

  private async handleSend(
    text: string,
    providerId?: string,
    model?: string
  ): Promise<void> {
    const userMessage: ChatMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.history.push(userMessage);
    this.post({ type: "append", message: userMessage });

    const snapshot = await collectContext();
    const contextPrompt = toContextPrompt(snapshot);

    const profile = SidekickConfig.getChatProfile();
    if (providerId) {
      profile.providerId = providerId;
    }
    if (model) {
      profile.model = model;
    }

    const messages = [
      {
        role: "system" as const,
        content: "You are Sidekick, an expert software engineering assistant.",
      },
      {
        role: "system" as const,
        content: contextPrompt,
      },
      ...this.history.slice(-20).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];

    let answer = "";
    this.post({ type: "assistant-start" });

    for await (const event of this.gateway.streamChat({ profile, messages })) {
      if (event.type === "text") {
        answer += event.delta;
        this.post({ type: "assistant-delta", delta: event.delta });
      }
      if (event.type === "error") {
        this.post({
          type: "assistant-delta",
          delta: `\n[error] ${event.message}`,
        });
      }
    }

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: answer || "(no response)",
      timestamp: Date.now(),
    };

    this.history.push(assistantMessage);
    await this.store.saveHistory(this.history);
    this.post({ type: "assistant-end" });
  }

  private async exportHistory(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      saveLabel: "Export Chat",
      filters: { Markdown: ["md"] },
      defaultUri: vscode.Uri.file("sidekick-chat.md"),
    });

    if (!uri) {
      return;
    }

    const markdown = this.history
      .map(
        (message) =>
          `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.content}\n`
      )
      .join("\n");

    await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, "utf8"));
    vscode.window.showInformationMessage("Chat exported.");
  }

  private post(message: OutgoingMessage): void {
    this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg-1: #0c111b;
      --bg-2: #182436;
      --panel: rgba(12, 18, 30, 0.86);
      --stroke: #2a3d55;
      --text: #dce8f7;
      --muted: #9db2c9;
      --accent: #4dd4ac;
      --user: #58a6ff;
      --assistant: #4dd4ac;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(1200px 460px at -10% -20%, #275f84 0%, transparent 55%),
        radial-gradient(900px 420px at 110% -10%, #1a5a4d 0%, transparent 50%),
        linear-gradient(150deg, var(--bg-1), var(--bg-2));
      font-family: "Segoe UI", "Noto Sans", sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--stroke);
      background: rgba(9, 14, 24, 0.86);
      backdrop-filter: blur(8px);
    }
    select, input, button, textarea {
      border: 1px solid var(--stroke);
      border-radius: 8px;
      background: rgba(11, 19, 31, 0.95);
      color: var(--text);
      font: inherit;
    }
    select, input, button { min-height: 34px; padding: 6px 10px; }
    button { cursor: pointer; }
    button:hover { border-color: var(--accent); }
    #messages {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 12px;
    }
    .msg {
      margin: 0 0 10px;
      padding: 10px 12px;
      border: 1px solid var(--stroke);
      border-radius: 10px;
      background: var(--panel);
      line-height: 1.45;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .msg.user { border-left: 3px solid var(--user); }
    .msg.assistant { border-left: 3px solid var(--assistant); }
    .input {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--stroke);
      background: rgba(9, 14, 24, 0.9);
    }
    textarea {
      min-height: 56px;
      max-height: 180px;
      resize: vertical;
      padding: 10px;
    }
    .model-row {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .model-picker {
      position: fixed;
      left: 12px;
      right: 12px;
      bottom: 84px;
      max-height: 280px;
      overflow: auto;
      border: 1px solid var(--stroke);
      border-radius: 10px;
      background: rgba(8, 14, 24, 0.98);
      box-shadow: 0 10px 36px rgba(0, 0, 0, 0.4);
      padding: 10px;
      z-index: 20;
    }
    .model-picker.hidden { display: none; }
    .provider-group { margin-bottom: 12px; }
    .provider-title { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .model-option { display: block; width: 100%; text-align: left; margin-bottom: 6px; }
    .model-option.active { border-color: var(--accent); background: rgba(77, 212, 172, 0.14); }
    pre {
      margin: 8px 0;
      padding: 10px;
      border: 1px solid #2c415b;
      border-radius: 8px;
      background: #08101b;
      overflow-x: auto;
    }
    code { font-family: Consolas, "Courier New", monospace; }
    .kw { color: #ffcf6e; }
    .str { color: #9be17d; }
    .num { color: #8fb8ff; }
  </style>
</head>
<body>
  <div class="toolbar">
    <div style="display:flex;align-items:center;color:var(--muted);font-size:12px;">Sidekick Chat</div>
    <button id="clear">Clear</button>
    <button id="export">Export</button>
    <button id="settings">Settings</button>
  </div>
  <div id="messages"></div>
  <div id="modelPicker" class="model-picker hidden"></div>
  <div class="input">
    <textarea id="input" placeholder="Ask Sidekick..."></textarea>
    <div class="model-row">
      <button id="modelPickerBtn">Model: -</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const modelPicker = document.getElementById('modelPicker');
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const input = document.getElementById('input');
    let providers = [];
    let activeProviderId = '';
    let activeModelId = '';
    let inProgress = null;

    function escapeHtml(text) {
      return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    }

    function highlightCode(code) {
      let out = escapeHtml(code);
      out = out.replace(new RegExp('\\\\b(function|const|let|var|if|else|for|while|return|class|import|export|async|await|try|catch|new)\\\\b', 'g'), '<span class="kw">$1</span>');
      out = out.replace(new RegExp('(["\\\'])([^"\\\'\\\\]*(?:\\\\.[^"\\\'\\\\]*)*)\\1', 'g'), '<span class="str">$&</span>');
      out = out.replace(new RegExp('\\\\b(\\\\d+(?:\\\\.\\\\d+)?)\\\\b', 'g'), '<span class="num">$1</span>');
      return out;
    }

    function renderMarkdown(text) {
      const tick = String.fromCharCode(96);
      const fence = tick + tick + tick;
      const escaped = escapeHtml(text);
      return escaped
        .replace(new RegExp(fence + '([\\s\\S]*?)' + fence, 'g'), (_, code) => '<pre><code>' + highlightCode(code) + '</code></pre>')
        .replace(new RegExp('\\\\*\\\\*(.*?)\\\\*\\\\*', 'g'), '<strong>$1</strong>')
        .replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), '<code>$1</code>')
        .replace(new RegExp('\\\\n', 'g'), '<br/>');
    }

    function append(role, content) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.innerHTML = renderMarkdown(content);
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    function setSelection(preferredProviderId, preferredModelId) {
      const provider = providers.find((item) => item.id === preferredProviderId) || providers[0];
      activeProviderId = provider ? provider.id : '';

      const models = Array.isArray(provider?.models) ? provider.models : [];
      if (models.length === 0) {
        activeModelId = preferredModelId || provider?.defaultModel || '';
      } else {
        const selected = models.find((item) => item.id === preferredModelId) || models[0];
        activeModelId = selected.id;
      }

      updateModelButton();
      renderModelPicker();
    }

    function updateModelButton() {
      const provider = providers.find((item) => item.id === activeProviderId);
      const model = (provider?.models || []).find((item) => item.id === activeModelId);
      const providerName = provider ? (provider.label || provider.id) : '(no provider)';
      const modelName = model
        ? (model.name || model.id) + ' [' + (model.endpointType || 'OPENAI') + ']'
        : activeModelId || '(no model)';
      modelPickerBtn.textContent = 'Model: ' + providerName + ' / ' + modelName;
    }

    function renderModelPicker() {
      modelPicker.innerHTML = '';
      for (const provider of providers) {
        const group = document.createElement('div');
        group.className = 'provider-group';

        const title = document.createElement('div');
        title.className = 'provider-title';
        title.textContent = (provider.label || provider.id) + (provider.enabled === false ? ' (OFF)' : '');
        group.appendChild(title);

        const models = Array.isArray(provider.models) ? provider.models : [];
        if (models.length === 0) {
          const btn = document.createElement('button');
          btn.className = 'model-option' + (provider.id === activeProviderId && !activeModelId ? ' active' : '');
          btn.textContent = provider.defaultModel || '(no model configured)';
          btn.onclick = () => {
            activeProviderId = provider.id;
            activeModelId = provider.defaultModel || '';
            updateModelButton();
            modelPicker.classList.add('hidden');
          };
          group.appendChild(btn);
        } else {
          for (const model of models) {
            const btn = document.createElement('button');
            const isActive = provider.id === activeProviderId && model.id === activeModelId;
            btn.className = 'model-option' + (isActive ? ' active' : '');
            btn.textContent = (model.name || model.id) + ' [' + (model.endpointType || 'OPENAI') + ']';
            btn.onclick = () => {
              activeProviderId = provider.id;
              activeModelId = model.id;
              updateModelButton();
              renderModelPicker();
              modelPicker.classList.add('hidden');
            };
            group.appendChild(btn);
          }
        }

        modelPicker.appendChild(group);
      }
    }

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      vscode.postMessage({
        type: 'send',
        text,
        providerId: activeProviderId,
        model: activeModelId
      });
      input.value = '';
    }

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      sendMessage();
    });

    modelPickerBtn.onclick = () => {
      modelPicker.classList.toggle('hidden');
    };

    document.getElementById('clear').onclick = () => vscode.postMessage({ type: 'clear' });
    document.getElementById('export').onclick = () => vscode.postMessage({ type: 'export' });
    document.getElementById('settings').onclick = () => vscode.postMessage({ type: 'open-settings' });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'history') {
        messages.innerHTML = '';
        providers = Array.isArray(msg.providers) ? msg.providers : [];
        for (const item of msg.history || []) {
          append(item.role, item.content);
        }
        setSelection(msg.profileProviderId || '', msg.profileModel || '');
      }

      if (msg.type === 'append') {
        append(msg.message.role, msg.message.content);
      }

      if (msg.type === 'assistant-start') {
        inProgress = append('assistant', '');
      }

      if (msg.type === 'assistant-delta' && inProgress) {
        inProgress.innerHTML += renderMarkdown(msg.delta);
        messages.scrollTop = messages.scrollHeight;
      }

      if (msg.type === 'assistant-end') {
        inProgress = null;
      }

      if (msg.type === 'seed') {
        input.value = msg.text;
        input.focus();
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
