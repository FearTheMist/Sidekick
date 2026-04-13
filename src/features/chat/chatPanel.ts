import * as vscode from "vscode";
import { AgentRunner } from "../../agent/agentRunner";
import { SidekickConfig } from "../../core/config";
import { LlmGateway, LlmMessage, ProviderConfig, RawMessageBatch } from "../../core/llm";
import {
  collectContext,
  getSelectedLocation,
  toContextPrompt,
} from "../../context/contextCollector";
import {
  buildHistoryId,
  ChatMessagePart,
  ChatHistoryItem,
  ChatMessage,
  ChatSelectionState,
  ChatStore,
} from "./chatStore";

type IncomingMessage =
  | { type: "ready" }
  | { type: "send"; text: string; providerId?: string; model?: string }
  | { type: "stop" }
  | { type: "reset-to-step"; messageId: string }
  | { type: "selection"; providerId?: string; model?: string }
  | { type: "clear" }
  | { type: "export" }
  | { type: "open-settings" };

type OutgoingMessage =
  | {
      type: "history";
      history: ChatHistoryItem[];
      providers: ProviderConfig[];
      profileProviderId: string;
      profileModel: string;
    }
  | { type: "selection-context"; location: string }
  | { type: "append"; message: ChatMessage }
  | { type: "assistant-start" }
  | { type: "assistant-delta"; delta: string }
  | { type: "assistant-finalize"; message: ChatMessage }
  | {
      type: "tool-activity";
      id: string;
      phase: "start" | "end";
      name: string;
      detail: string;
    }
  | { type: "assistant-end" }
  | { type: "seed"; text: string };

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "sidekick.chatView";
  private static qwenPromptCache?: string;

  private view?: vscode.WebviewView;
  private readonly store: ChatStore;
  private readonly agentRunner: AgentRunner;
  private history: ChatHistoryItem[];
  private selectedProviderId: string;
  private selectedModel?: string;
  private activeRun?: AbortController;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly gateway: LlmGateway
  ) {
    this.store = new ChatStore(context);
    this.agentRunner = new AgentRunner(gateway);
    this.history = this.store.getHistory();
    const profile = SidekickConfig.getChatProfile();
    const saved = this.store.getSelection();
    this.selectedProviderId = saved?.providerId || profile.providerId;
    this.selectedModel = saved?.model || profile.model;
    this.context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.postSelectionContext();
      })
    );
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.postSelectionContext();
      })
    );
  }

  getActiveProfile(): { providerId: string; model?: string } {
    return {
      providerId: this.selectedProviderId,
      model: this.selectedModel,
    };
  }

  refreshProviders(): void {
    this.ensureValidSelection(SidekickConfig.getProviders());
    this.postHistory();
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
          this.postHistory();
          this.postSelectionContext();
          break;
        }
        case "send": {
          await this.handleSend(raw.text, raw.providerId, raw.model);
          break;
        }
        case "stop": {
          this.activeRun?.abort();
          break;
        }
        case "reset-to-step": {
          await this.resetToStep(raw.messageId);
          break;
        }
        case "selection": {
          if (raw.providerId) {
            this.selectedProviderId = raw.providerId;
          }
          if (typeof raw.model === "string") {
            this.selectedModel = raw.model;
          }
          await this.saveSelection();
          break;
        }
        case "clear": {
          this.history = [];
          await this.store.clear();
          this.postHistory();
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
    if (this.activeRun) {
      return;
    }

    const userMessage: ChatMessage = {
      id: buildHistoryId("message"),
      kind: "message",
      role: "user",
      content: text,
      timestamp: Date.now(),
      parts: this.buildUserMessageParts(text),
    };
    this.history.push(userMessage);
    void this.store.saveHistory(this.history);
    this.post({ type: "append", message: userMessage });

    const snapshot = await collectContext(text);
    const contextPrompt = toContextPrompt(snapshot);

    const profile = SidekickConfig.getChatProfile();
    if (providerId) {
      profile.providerId = providerId;
      this.selectedProviderId = providerId;
    }
    if (model) {
      profile.model = model;
      this.selectedModel = model;
    }
    await this.saveSelection();

    const provider = SidekickConfig.getProviders().find(
      (item) => item.id === profile.providerId
    );
    const systemPrompt = await this.buildChatSystemPrompt(provider, profile.model);

    const messages: LlmMessage[] = [
      {
        role: "system" as const,
        content: systemPrompt,
      },
      {
        role: "system" as const,
        content: contextPrompt,
      },
      ...this.history
        .filter((item): item is ChatMessage => item.kind === "message")
        .slice(-20)
        .map((message) => ({
          role: message.role,
          content:
            message.role === "user" && Array.isArray(message.parts) && message.parts.length > 0
              ? message.parts.map((part) => ({ ...part }))
              : message.content,
        })),
    ];

    let answer = "";
    let rawMessageBatches: RawMessageBatch[] = [];
    const workspaceMutations: import("../../agent/builtinTools").WorkspaceMutation[] = [];
    const abortController = new AbortController();
    this.activeRun = abortController;
    this.post({ type: "assistant-start" });

    try {
      for await (const event of this.agentRunner.run(
        messages,
        profile,
        abortController.signal,
        workspaceMutations
      )) {
        if (event.type === "request_messages") {
          rawMessageBatches = [event.batch];
        }
        if (event.type === "text") {
          answer += event.delta;
          this.post({ type: "assistant-delta", delta: event.delta });
        }
        if (event.type === "tool_activity") {
          this.history.push({
            kind: "tool_activity",
            id: event.id,
            phase: event.phase,
            name: event.name,
            detail: event.detail,
            timestamp: Date.now(),
          });
          void this.store.saveHistory(this.history);
          this.post({
            type: "tool-activity",
            id: event.id,
            phase: event.phase,
            name: event.name,
            detail: event.detail,
          });
        }
        if (event.type === "error") {
          const errorText = `\n[error] ${event.message}`;
          answer += errorText;
          this.post({
            type: "assistant-delta",
            delta: errorText,
          });
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const errorText = `\n[error] ${error instanceof Error ? error.message : String(error)}`;
        answer += errorText;
        this.post({ type: "assistant-delta", delta: errorText });
      }
    } finally {
      this.activeRun = undefined;
    }

    const finalContent =
      answer || (abortController.signal.aborted ? "(stopped)" : "(no response)");

    userMessage.workspaceMutations = workspaceMutations;

    if (!answer) {
      this.post({ type: "assistant-delta", delta: finalContent });
    }

    const assistantMessage: ChatMessage = {
      id: buildHistoryId("message"),
      kind: "message",
      role: "assistant",
      content: finalContent,
      timestamp: Date.now(),
      rawMessages: rawMessageBatches[0]?.messages || messages.map((message) => ({ ...message })),
      rawMessageBatches,
    };

    this.history.push(assistantMessage);
    await this.store.saveHistory(this.history);
    this.post({ type: "assistant-finalize", message: assistantMessage });
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
      .map((item) => {
        if (item.kind === "tool_activity") {
          return `## Tool ${item.phase === "start" ? "Running" : "Done"}: ${item.name}\n\n${item.detail}\n`;
        }
        return `## ${item.role === "user" ? "User" : "Assistant"}\n\n${item.content}\n`;
      })
      .join("\n");

    await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, "utf8"));
    vscode.window.showInformationMessage("Chat exported.");
  }

  private post(message: OutgoingMessage): void {
    this.view?.webview.postMessage(message);
  }

  private async resetToStep(messageId: string): Promise<void> {
    const targetIndex = this.history.findIndex(
      (item) => item.kind === "message" && item.id === messageId && item.role === "user"
    );
    if (targetIndex === -1) {
      return;
    }

    const target = this.history[targetIndex] as ChatMessage;
    const rollback = this.history
      .slice(targetIndex)
      .filter(
        (item): item is ChatMessage => item.kind === "message" && item.role === "user"
      )
      .flatMap((item) => item.workspaceMutations || []);

    await this.rollbackWorkspaceMutations(rollback);
    this.history = this.history.slice(0, targetIndex);
    await this.store.saveHistory(this.history);
    this.postHistory();
    this.post({ type: "seed", text: target.content });
  }

  private async rollbackWorkspaceMutations(mutations: import("../../agent/builtinTools").WorkspaceMutation[]): Promise<void> {
    for (let index = mutations.length - 1; index >= 0; index -= 1) {
      const mutation = mutations[index];
      const uri = vscode.Uri.file(mutation.path);

      if (!mutation.existedBefore) {
        try {
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
        } catch {
          continue;
        }
        continue;
      }

      if (typeof mutation.previousContent !== "string") {
        continue;
      }

      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(mutation.previousContent, "utf8")
      );
    }
  }

  private postHistory(): void {
    const providers = SidekickConfig.getProviders();
    this.ensureValidSelection(providers);
    this.post({
      type: "history",
      history: this.history,
      providers,
      profileProviderId: this.selectedProviderId,
      profileModel: this.selectedModel || "",
    });
  }

  private postSelectionContext(): void {
    this.post({
      type: "selection-context",
      location: getSelectedLocation(vscode.window.activeTextEditor),
    });
  }

  private async buildChatSystemPrompt(
    provider: ProviderConfig | undefined,
    model: string | undefined
  ): Promise<string> {
    const base = [
      "You are Sidekick, an expert software engineering assistant.",
      "Use first-principles reasoning from the user's real goal, not from surface wording alone.",
      "Keep the solution on the shortest correct path. Do not add compatibility layers, fallback logic, or extra designs unless the user explicitly asks for them.",
      "Ensure the full logic is correct end to end before answering or acting.",
    ].join(" ");

    if (detectVendor(provider, model) !== "qwen") {
      return base;
    }

    if (ChatPanelProvider.qwenPromptCache) {
      return ChatPanelProvider.qwenPromptCache;
    }

    try {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, "src", "prompt", "qwen.txt");
      const bytes = await vscode.workspace.fs.readFile(uri);
      const prompt = Buffer.from(bytes).toString("utf8").trim();
      if (prompt) {
        ChatPanelProvider.qwenPromptCache = prompt;
        return prompt;
      }
    } catch {
      // Fall through to base prompt if the prompt file cannot be read.
    }

    return base;
  }

  private buildUserMessageParts(text: string): ChatMessagePart[] | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return text
        ? [
            {
              id: buildHistoryId("part"),
              type: "text",
              text,
            },
          ]
        : undefined;
    }

    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    const startChar = editor.selection.start.character;
    const endChar = editor.selection.end.character;
    const preview = editor.document.getText(editor.selection).slice(0, 400);
    const fileUrl = `${editor.document.uri.toString()}?start=${startLine}&end=${endLine}`;

    return [
      {
        id: buildHistoryId("part"),
        type: "text",
        text,
      },
      {
        id: buildHistoryId("part"),
        type: "file",
        mime: "text/plain",
        filename: relativePath,
        url: fileUrl,
      },
      {
        id: buildHistoryId("part"),
        type: "text",
        synthetic: true,
        text: `The user made the following comment regarding lines ${startLine} through ${endLine} of ${relativePath}: ${text}`,
        metadata: {
          opencodeComment: {
            path: relativePath,
            selection: {
              startLine,
              endLine,
              startChar,
              endChar,
            },
            comment: text,
            preview,
            origin: "file",
          },
        },
      },
    ];
  }

  private ensureValidSelection(providers: ProviderConfig[]): void {
    if (providers.length === 0) {
      this.selectedProviderId = "";
      this.selectedModel = "";
      return;
    }

    let provider = providers.find((item) => item.id === this.selectedProviderId);
    if (!provider) {
      provider = providers[0];
      this.selectedProviderId = provider.id;
    }

    const models = provider.models || [];
    if (models.length === 0) {
      this.selectedModel = provider.defaultModel || this.selectedModel || "";
      return;
    }

    const exists = models.some((item) => item.id === this.selectedModel);
    if (!exists) {
      this.selectedModel = models[0].id;
    }
  }

  private async saveSelection(): Promise<void> {
    const selection: ChatSelectionState = {
      providerId: this.selectedProviderId,
      model: this.selectedModel,
    };
    await this.store.saveSelection(selection);
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
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      margin: 0;
      padding: 0;
      line-height: 1.45;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .msg.user {
      align-self: flex-end;
      max-width: 92%;
      padding: 10px 12px;
      border: 1px solid var(--stroke);
      border-left: 3px solid var(--user);
      border-radius: 10px;
      background: var(--panel);
    }
    .msg.assistant {
      align-self: stretch;
      max-width: 100%;
      padding: 0;
      border: none;
      background: transparent;
    }
    .thinking {
      color: var(--muted);
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .thinking-dots {
      display: inline-flex;
      gap: 1px;
    }
    .thinking-dots span {
      opacity: 0.2;
      animation: thinking-dot 1.2s infinite;
    }
    .thinking-dots span:nth-child(2) {
      animation-delay: 0.2s;
    }
    .thinking-dots span:nth-child(3) {
      animation-delay: 0.4s;
    }
    @keyframes thinking-dot {
      0%, 20% { opacity: 0.2; }
      50% { opacity: 1; }
      100% { opacity: 0.2; }
    }
    .tool-msg {
      border-left: 3px solid #eab308;
      background: rgba(35, 29, 7, 0.35);
      font-size: 12px;
    }
    .tool-head {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #f5d87b;
      margin-bottom: 6px;
    }
    .tool-badge {
      border: 1px solid #9f7b23;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      color: #f5d87b;
    }
    .tool-detail {
      margin: 0;
      padding: 6px 8px;
      border: 1px solid #4b3a13;
      border-radius: 6px;
      background: rgba(9, 8, 4, 0.5);
      white-space: pre-wrap;
      word-break: break-word;
      color: #d9cda4;
    }
    .msg-actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }
    .msg-action {
      min-height: 28px;
      padding: 4px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .raw-trigger {
      min-height: 28px;
      padding: 4px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 12, 0.42);
      opacity: 0;
      pointer-events: none;
      transition: opacity 140ms ease;
      z-index: 40;
    }
    .drawer-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }
    .raw-drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(520px, 92vw);
      height: 100vh;
      display: flex;
      flex-direction: column;
      border-left: 1px solid var(--stroke);
      background: rgba(8, 14, 24, 0.98);
      box-shadow: -18px 0 40px rgba(0, 0, 0, 0.35);
      transform: translateX(100%);
      transition: transform 160ms ease;
      z-index: 50;
    }
    .raw-drawer.open {
      transform: translateX(0);
    }
    .raw-drawer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border-bottom: 1px solid var(--stroke);
    }
    .raw-drawer-title {
      min-width: 0;
    }
    .raw-drawer-title strong {
      display: block;
      font-size: 13px;
    }
    .raw-drawer-title span {
      color: var(--muted);
      font-size: 12px;
    }
    .raw-drawer-close {
      min-width: 34px;
    }
    .raw-drawer-body {
      flex: 1;
      overflow: auto;
      padding: 12px;
    }
    .raw-box {
      border: 1px solid #2c415b;
      border-radius: 8px;
      background: rgba(8, 16, 27, 0.78);
      overflow: hidden;
      margin-bottom: 10px;
    }
    .raw-box summary {
      cursor: pointer;
      padding: 8px 10px;
      color: var(--muted);
      font-size: 12px;
      user-select: none;
    }
    .raw-item {
      border-top: 1px solid #223247;
    }
    .raw-item summary {
      cursor: pointer;
      padding: 8px 10px;
      list-style: none;
    }
    .raw-item summary::-webkit-details-marker {
      display: none;
    }
    .raw-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
    }
    .raw-item-body {
      padding: 0 10px 10px;
    }
    .raw-tag {
      border: 1px solid #35506d;
      border-radius: 999px;
      padding: 1px 7px;
      background: rgba(20, 34, 52, 0.8);
    }
    .raw-content {
      margin: 0;
      padding: 8px;
      border: 1px solid #23364d;
      border-radius: 6px;
      background: #08101b;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text);
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
    }
    .input {
      display: grid;
      gap: 8px;
      padding: 10px;
      border-top: 1px solid var(--stroke);
      background: rgba(9, 14, 24, 0.9);
    }
    .input-shell {
      display: grid;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--stroke);
      border-radius: 10px;
      background: rgba(13, 20, 34, 0.94);
    }
    .selection-context {
      min-height: 18px;
      color: var(--muted);
      font-size: 12px;
    }
    .selection-context.hidden {
      display: none;
    }
    .stop-btn {
      min-width: 22px;
      min-height: 22px;
      width: 22px;
      height: 22px;
      padding: 0;
      border-color: transparent;
      color: #ffd5dc;
      background: transparent;
      justify-self: end;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .stop-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }
    textarea {
      min-height: 56px;
      max-height: 300px;
      resize: none;
      width: 100%;
      padding: 0;
      border-radius: 0;
      border: none;
      background: transparent;
      color: var(--text);
    }
    .model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 2px;
    }
    .model-row button:first-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      text-align: left;
      border-color: transparent;
      background: transparent;
      min-height: 22px;
      line-height: 22px;
      padding-top: 0;
      padding-bottom: 0;
      padding-left: 0;
      padding-right: 0;
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
  <div id="drawerBackdrop" class="drawer-backdrop"></div>
  <aside id="rawDrawer" class="raw-drawer" aria-hidden="true">
    <div class="raw-drawer-head">
      <div class="raw-drawer-title">
        <strong>Raw Messages</strong>
        <span id="rawDrawerMeta"></span>
      </div>
      <button id="rawDrawerClose" class="raw-drawer-close">Close</button>
    </div>
    <div id="rawDrawerBody" class="raw-drawer-body"></div>
  </aside>
  <div id="modelPicker" class="model-picker hidden"></div>
  <div class="input">
    <div id="selectionContext" class="selection-context hidden"></div>
    <div class="input-shell">
      <textarea id="input" placeholder="Ask Sidekick..."></textarea>
      <div class="model-row">
        <button id="modelPickerBtn">Model: -</button>
        <button id="stop" class="stop-btn" disabled aria-label="Start">↑</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const modelPicker = document.getElementById('modelPicker');
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const input = document.getElementById('input');
    const stopBtn = document.getElementById('stop');
    const selectionContext = document.getElementById('selectionContext');
    const rawDrawer = document.getElementById('rawDrawer');
    const rawDrawerBody = document.getElementById('rawDrawerBody');
    const rawDrawerMeta = document.getElementById('rawDrawerMeta');
    const rawDrawerClose = document.getElementById('rawDrawerClose');
    const drawerBackdrop = document.getElementById('drawerBackdrop');
    let providers = [];
    let activeProviderId = '';
    let activeModelId = '';
    let inProgress = null;
    let isRunning = false;
    const toolCards = new Map();

    function syncInputHeight() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 300) + 'px';
      input.style.overflowY = input.scrollHeight > 300 ? 'auto' : 'hidden';
    }

    function setRunState(nextRunning) {
      isRunning = nextRunning;
      stopBtn.disabled = false;
      stopBtn.textContent = nextRunning ? '❚❚' : '↑';
      stopBtn.setAttribute('aria-label', nextRunning ? 'Stop' : 'Start');
    }

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

    function normalizeRawBatches(rawMessageBatches, rawMessages) {
      if (Array.isArray(rawMessageBatches) && rawMessageBatches.length > 0) {
        return rawMessageBatches;
      }
      if (Array.isArray(rawMessages) && rawMessages.length > 0) {
        return [{ title: 'Initial request', messages: rawMessages }];
      }
      return [];
    }

    function renderMessageParts(parts) {
      if (!Array.isArray(parts) || parts.length === 0) {
        return '';
      }

      return parts.map((part, index) => {
        const meta = [
          '<span class="raw-tag">#' + (index + 1) + '</span>',
          '<span class="raw-tag">' + escapeHtml(part.type || '') + '</span>'
        ];
        if (part.synthetic) {
          meta.push('<span class="raw-tag">synthetic</span>');
        }
        if (part.type === 'file') {
          meta.push('<span class="raw-tag">' + escapeHtml(part.filename || '') + '</span>');
          return '<details class="raw-box" open><summary>File Part</summary><div class="raw-item"><div class="raw-meta">' + meta.join('') + '</div><pre class="raw-content">' + escapeHtml(JSON.stringify({ filename: part.filename, mime: part.mime, url: part.url, metadata: part.metadata || null }, null, 2)) + '</pre></div></details>';
        }
        return '<details class="raw-box" open><summary>Text Part</summary><div class="raw-item"><div class="raw-meta">' + meta.join('') + '</div><pre class="raw-content">' + escapeHtml(part.text || '') + '</pre></div></details>';
      }).join('');
    }

    function renderRawMessages(rawMessageBatches, rawMessages) {
      const batches = normalizeRawBatches(rawMessageBatches, rawMessages);
      if (batches.length === 0) {
        return '';
      }

      return batches.map((batch) => {
        const items = batch.messages.map((message, index) => {
          const meta = [
            '<span class="raw-tag">#' + (index + 1) + '</span>',
            '<span class="raw-tag">' + escapeHtml(message.role || '') + '</span>'
          ];
          if (message.name) {
            meta.push('<span class="raw-tag">name: ' + escapeHtml(message.name) + '</span>');
          }
          if (message.toolCallId) {
            meta.push('<span class="raw-tag">toolCallId: ' + escapeHtml(message.toolCallId) + '</span>');
          }
          const content = Array.isArray(message.content)
            ? JSON.stringify(message.content, null, 2)
            : (message.content || '');
          return '<details class="raw-item"><summary><div class="raw-meta">' + meta.join('') + '</div></summary><div class="raw-item-body"><pre class="raw-content">' + escapeHtml(content) + '</pre></div></details>';
        }).join('');

        const summary = batches.length === 1
          ? 'Raw Messages (' + batch.messages.length + ')'
          : escapeHtml(batch.title) + ' (' + batch.messages.length + ')';
        return '<details class="raw-box" open><summary>' + summary + '</summary>' + items + '</details>';
      }).join('');
    }

    function openRawDrawer(role, rawMessageBatches, rawMessages, parts) {
      const batches = normalizeRawBatches(rawMessageBatches, rawMessages);
      rawDrawerBody.innerHTML = renderMessageParts(parts) + renderRawMessages(rawMessageBatches, rawMessages);
      const total = batches.reduce((count, batch) => count + batch.messages.length, 0);
      rawDrawerMeta.textContent = role + ' message, ' + (Array.isArray(parts) ? parts.length : 0) + ' part' + ((Array.isArray(parts) ? parts.length : 0) === 1 ? '' : 's') + ', ' + total + ' item' + (total === 1 ? '' : 's');
      rawDrawer.classList.add('open');
      rawDrawer.setAttribute('aria-hidden', 'false');
      drawerBackdrop.classList.add('open');
    }

    function closeRawDrawer() {
      rawDrawer.classList.remove('open');
      rawDrawer.setAttribute('aria-hidden', 'true');
      drawerBackdrop.classList.remove('open');
    }

    function attachMessageActions(container, role, content, rawMessageBatches, rawMessages, messageId, parts) {
      const existingActions = container.querySelectorAll('.msg-actions');
      existingActions.forEach((node) => node.remove());

      if (role === 'user' && messageId) {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'msg-action';
        copyBtn.textContent = 'Copy';
        copyBtn.onclick = () => copyText(content);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'msg-action';
        resetBtn.textContent = 'Reset to Here';
        resetBtn.onclick = () => vscode.postMessage({ type: 'reset-to-step', messageId });

        actions.appendChild(copyBtn);
        actions.appendChild(resetBtn);
        if (Array.isArray(parts) && parts.length > 0) {
          const partsBtn = document.createElement('button');
          partsBtn.className = 'msg-action';
          partsBtn.textContent = 'Parts (' + parts.length + ')';
          partsBtn.onclick = () => openRawDrawer(role, rawMessageBatches, rawMessages, parts);
          actions.appendChild(partsBtn);
        }
        container.appendChild(actions);
      }

      const batches = normalizeRawBatches(rawMessageBatches, rawMessages);
      if (batches.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';

        const button = document.createElement('button');
        button.className = 'msg-action raw-trigger';
        button.textContent = 'Raw Messages';
        button.onclick = () => openRawDrawer(role, rawMessageBatches, rawMessages, parts);

        actions.appendChild(button);
        container.appendChild(actions);
      }
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return;
      }

      const input = document.createElement('textarea');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }

    function append(role, content, rawMessageBatches, rawMessages, messageId, parts) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.innerHTML = renderMarkdown(content);
      attachMessageActions(div, role, content, rawMessageBatches, rawMessages, messageId, parts);
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    function appendToolActivity(id, phase, name, detail) {
      let card = toolCards.get(id);
      if (!card) {
        const container = document.createElement('div');
        container.className = 'msg assistant tool-msg';

        const header = document.createElement('div');
        header.className = 'tool-head';

        const badge = document.createElement('span');
        badge.className = 'tool-badge';

        const title = document.createElement('span');
        title.textContent = name;

        header.appendChild(badge);
        header.appendChild(title);

        const detailBox = document.createElement('details');
        const summary = document.createElement('summary');
        const pre = document.createElement('pre');
        pre.className = 'tool-detail';
        detailBox.appendChild(summary);
        detailBox.appendChild(pre);

        container.appendChild(header);
        container.appendChild(detailBox);
        if (inProgress && inProgress.parentElement === messages) {
          messages.insertBefore(container, inProgress);
        } else {
          messages.appendChild(container);
        }

        card = { badge, summary, pre, detailBox };
        toolCards.set(id, card);
      }

      card.badge.textContent = phase === 'start' ? 'RUNNING' : 'DONE';
      card.summary.textContent =
        phase === 'start' ? 'Show operation detail' : 'Show result summary';
      card.pre.textContent = detail || '(empty)';
      card.detailBox.open = phase === 'start';

      messages.scrollTop = messages.scrollHeight;
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

      emitSelection();
      updateModelButton();
      renderModelPicker();
    }

    function emitSelection() {
      vscode.postMessage({
        type: 'selection',
        providerId: activeProviderId,
        model: activeModelId
      });
    }

    function updateModelButton() {
      const provider = providers.find((item) => item.id === activeProviderId);
      const model = (provider?.models || []).find((item) => item.id === activeModelId);
      const modelName = model
        ? (model.name || model.id)
        : activeModelId || provider?.defaultModel || '(no model)';
      modelPickerBtn.textContent = modelName;
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
            emitSelection();
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
              emitSelection();
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
      if (!text || isRunning) return;
      vscode.postMessage({
        type: 'send',
        text,
        providerId: activeProviderId,
        model: activeModelId
      });
      input.value = '';
      syncInputHeight();
    }

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      sendMessage();
    });
    input.addEventListener('input', () => syncInputHeight());

    modelPickerBtn.onclick = () => {
      modelPicker.classList.toggle('hidden');
    };

    document.getElementById('clear').onclick = () => vscode.postMessage({ type: 'clear' });
    document.getElementById('export').onclick = () => vscode.postMessage({ type: 'export' });
    document.getElementById('settings').onclick = () => vscode.postMessage({ type: 'open-settings' });
    stopBtn.onclick = () => {
      if (isRunning) {
        vscode.postMessage({ type: 'stop' });
        return;
      }
      sendMessage();
    };
    rawDrawerClose.onclick = () => closeRawDrawer();
    drawerBackdrop.onclick = () => closeRawDrawer();

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeRawDrawer();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'history') {
        messages.innerHTML = '';
        toolCards.clear();
        providers = Array.isArray(msg.providers) ? msg.providers : [];
        for (const item of msg.history || []) {
        if (item.kind === 'tool_activity') {
          appendToolActivity(item.id || item.name, item.phase, item.name, item.detail);
        } else {
          append(
            item.role,
            item.content,
            item.rawMessageBatches,
            item.rawMessages,
            item.id,
            item.parts
          );
        }
      }
        setSelection(msg.profileProviderId || '', msg.profileModel || '');
      }

      if (msg.type === 'selection-context') {
        if (msg.location) {
          selectionContext.textContent = 'Selected: ' + msg.location;
          selectionContext.classList.remove('hidden');
        } else {
          selectionContext.textContent = '';
          selectionContext.classList.add('hidden');
        }
      }

      if (msg.type === 'append') {
        append(
          msg.message.role,
          msg.message.content,
          msg.message.rawMessageBatches,
          msg.message.rawMessages,
          msg.message.id,
          msg.message.parts
        );
      }

      if (msg.type === 'assistant-start') {
        inProgress = append('assistant', '');
        inProgress.dataset.loading = '1';
        inProgress.innerHTML = '<span class="thinking"><span>Sidekick is thinking</span><span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></span>';
        setRunState(true);
      }

      if (msg.type === 'assistant-delta' && inProgress) {
        if (inProgress.dataset.loading === '1') {
          inProgress.innerHTML = '';
          delete inProgress.dataset.loading;
        }
        inProgress.innerHTML += renderMarkdown(msg.delta);
        messages.scrollTop = messages.scrollHeight;
      }

      if (msg.type === 'assistant-finalize' && inProgress) {
        attachMessageActions(
          inProgress,
          msg.message.role,
          msg.message.content,
          msg.message.rawMessageBatches,
          msg.message.rawMessages,
          msg.message.id,
          msg.message.parts
        );
      }

      if (msg.type === 'tool-activity') {
        appendToolActivity(msg.id || msg.name, msg.phase, msg.name, msg.detail);
      }

      if (msg.type === 'assistant-end') {
        inProgress = null;
        setRunState(false);
      }

      if (msg.type === 'seed') {
        input.value = msg.text;
        syncInputHeight();
        input.focus();
      }
    });

    syncInputHeight();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function detectVendor(
  provider: ProviderConfig | undefined,
  model: string | undefined
): "openai" | "glm" | "qwen" | "other" {
  if (!provider) {
    return "other";
  }

  const joined = [provider.id, provider.label, provider.baseUrl, model || ""]
    .join(" ")
    .toLowerCase();

  if (joined.includes("zhipu") || joined.includes("glm")) {
    return "glm";
  }
  if (joined.includes("qwen") || joined.includes("dashscope")) {
    return "qwen";
  }
  if (joined.includes("openai")) {
    return "openai";
  }
  return "other";
}
