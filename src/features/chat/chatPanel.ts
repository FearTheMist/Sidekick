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
      --bg: #07080a;
      --surface: #101111;
      --surface-2: #0d0d0d;
      --surface-3: #1b1c1e;
      --stroke: rgba(255, 255, 255, 0.08);
      --stroke-soft: rgba(255, 255, 255, 0.06);
      --stroke-strong: #252829;
      --text: #f9f9f9;
      --muted: #9c9c9d;
      --dim: #6a6b6c;
      --blue: #55b3ff;
      --blue-soft: hsla(202, 100%, 67%, 0.15);
      --green: #5fc992;
      --yellow: #ffbc33;
      --red: #ff6363;
      --red-soft: hsla(0, 100%, 69%, 0.15);
      --ring: rgb(27, 28, 30) 0px 0px 0px 1px, rgb(7, 8, 10) 0px 0px 0px 1px inset;
      --floating: rgba(0, 0, 0, 0.5) 0px 0px 0px 2px, rgba(255, 255, 255, 0.19) 0px 0px 14px, rgba(255, 255, 255, 0.05) 0px 1px 0px 0px inset;
      --button-shadow: rgba(255, 255, 255, 0.05) 0px 1px 0px 0px inset, rgba(255, 255, 255, 0.16) 0px 0px 0px 1px, rgba(0, 0, 0, 0.2) 0px -1px 0px 0px inset;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      color: var(--text);
      background:
        radial-gradient(900px 420px at 50% -10%, rgba(215, 201, 175, 0.05) 0%, transparent 60%),
        radial-gradient(800px 360px at 110% 0%, rgba(85, 179, 255, 0.08) 0%, transparent 58%),
        radial-gradient(700px 280px at -10% 0%, rgba(255, 99, 99, 0.08) 0%, transparent 55%),
        var(--bg);
      font-family: Inter, "Segoe UI", "Noto Sans", sans-serif;
      font-feature-settings: "calt" 1, "kern" 1, "liga" 1, "ss03" 1;
      letter-spacing: 0.2px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 6px;
      padding: 8px 12px 6px;
      background: rgba(7, 8, 10, 0.72);
      backdrop-filter: blur(12px);
    }
    select, input, button, textarea {
      border: 1px solid var(--stroke);
      border-radius: 8px;
      background: rgba(13, 13, 13, 0.95);
      color: var(--text);
      font: inherit;
      letter-spacing: inherit;
    }
    select, input, button { min-height: 34px; padding: 6px 10px; }
    button {
      cursor: pointer;
      box-shadow: var(--button-shadow);
      transition: opacity 140ms ease;
    }
    .toolbar button:hover {
      color: var(--text);
    }
    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      min-width: 32px;
      height: 32px;
      min-height: 32px;
      padding: 0;
      border: none;
      border-radius: 10px;
      background: transparent;
      box-shadow: none;
      color: var(--muted);
    }
    .icon-button:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.05);
    }
    .icon-button svg {
      width: 18px;
      height: 18px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .msg-action svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    button:hover { opacity: 0.78; }
    button:focus, textarea:focus, input:focus, select:focus {
      outline: none;
      border-color: inherit;
      box-shadow: none;
    }
    #messages {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
    }
    .msg {
      margin: 0;
      padding: 0;
      line-height: 1.6;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .msg-wrap.user {
      align-self: flex-end;
      max-width: 92%;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }
    .msg.user {
      padding: 8px;
      border: 1px solid var(--stroke-soft);
      border-radius: 8px;
      background: rgba(16, 17, 17, 0.9);
      box-shadow: var(--ring);
    }
    .msg.assistant {
      align-self: stretch;
      max-width: 100%;
      padding: 0;
      border: none;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
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
      border: 1px solid rgba(255, 188, 51, 0.16);
      background: rgba(255, 188, 51, 0.08);
      font-size: 12px;
    }
    .tool-head {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #ffd780;
      margin-bottom: 6px;
    }
    .tool-badge {
      border: 1px solid rgba(255, 188, 51, 0.2);
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      color: #ffd780;
      background: rgba(255, 188, 51, 0.1);
    }
    .tool-detail {
      margin: 0;
      padding: 6px 8px;
      border: 1px solid rgba(255, 188, 51, 0.12);
      border-radius: 6px;
      background: rgba(13, 13, 13, 0.78);
      white-space: pre-wrap;
      word-break: break-word;
      color: #f0dfad;
    }
    .msg-actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 120ms ease;
    }
    .msg-wrap.user .msg-actions {
      justify-content: flex-end;
    }
    .msg-wrap.user:hover > .msg-actions,
    .msg-wrap.user:focus-within > .msg-actions,
    .msg.assistant:hover > .msg-actions,
    .msg.assistant:focus-within > .msg-actions {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }
    .msg-action {
      width: 16px;
      min-width: 16px;
      height: 16px;
      min-height: 16px;
      padding: 0;
      color: var(--muted);
      border: none;
      border-radius: 999px;
      background: transparent;
      box-shadow: none;
    }
    .raw-trigger {
      color: var(--muted);
    }
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 12, 0.58);
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
      border-left: 1px solid var(--stroke-soft);
      background: rgba(7, 8, 10, 0.98);
      box-shadow: var(--floating);
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
      border-bottom: 1px solid var(--stroke-strong);
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
      flex: none;
    }
    .raw-drawer-body {
      flex: 1;
      overflow: auto;
      padding: 12px;
    }
    .raw-box {
      border: 1px solid var(--stroke-soft);
      border-radius: 12px;
      background: rgba(16, 17, 17, 0.82);
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
      border-top: 1px solid var(--stroke-strong);
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
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      padding: 1px 7px;
      background: rgba(255, 255, 255, 0.04);
    }
    .raw-content {
      margin: 0;
      padding: 8px;
      border: 1px solid var(--stroke-strong);
      border-radius: 6px;
      background: #0d0d0d;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text);
      font-family: "GeistMono", Consolas, "Courier New", monospace;
      font-size: 12px;
    }
    .input {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--stroke-strong);
      background: rgba(7, 8, 10, 0.92);
    }
    .input-shell {
      display: grid;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--stroke-soft);
      border-radius: 16px;
      background: rgba(16, 17, 17, 0.96);
      box-shadow: var(--ring);
    }
    .input-shell:focus-within {
      border-color: var(--stroke-soft);
      box-shadow: var(--ring);
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
      min-width: 34px;
      min-height: 34px;
      width: 34px;
      height: 34px;
      padding: 0;
      border-radius: 999px;
      border-color: transparent;
      color: var(--text);
      background: rgba(255, 255, 255, 0.06);
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
      line-height: 1.6;
    }
    textarea::placeholder { color: var(--dim); }
    .model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .model-row button:first-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      text-align: left;
      border-radius: 999px;
      border-color: transparent;
      background: rgba(255, 255, 255, 0.04);
      min-height: 34px;
      line-height: 22px;
      padding: 6px 12px;
    }
    .model-picker {
      position: fixed;
      left: 12px;
      right: 12px;
      bottom: 84px;
      max-height: 280px;
      overflow: auto;
      border: 1px solid var(--stroke-soft);
      border-radius: 16px;
      background: rgba(7, 8, 10, 0.98);
      box-shadow: var(--floating);
      padding: 12px;
      z-index: 20;
    }
    .model-picker.hidden { display: none; }
    .provider-group { margin-bottom: 14px; }
    .provider-title { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .model-option {
      display: block;
      width: 100%;
      text-align: left;
      margin-bottom: 8px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
    }
    .model-option.active {
      border-color: rgba(85, 179, 255, 0.18);
      background: linear-gradient(180deg, rgba(85, 179, 255, 0.14), rgba(85, 179, 255, 0.08));
    }
    pre {
      margin: 8px 0;
      padding: 10px;
      border: 1px solid var(--stroke-strong);
      border-radius: 10px;
      background: #0d0d0d;
      overflow-x: auto;
    }
    code { font-family: "GeistMono", Consolas, "Courier New", monospace; }
    .kw { color: #ffbc33; }
    .str { color: #5fc992; }
    .num { color: #55b3ff; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="clear" class="icon-button" type="button" aria-label="Clear chat" title="Clear chat"></button>
    <button id="export" class="icon-button" type="button" aria-label="Export chat" title="Export chat"></button>
    <button id="settings" class="icon-button" type="button" aria-label="Open settings" title="Open settings"></button>
  </div>
  <div id="messages"></div>
  <div id="drawerBackdrop" class="drawer-backdrop"></div>
  <aside id="rawDrawer" class="raw-drawer" aria-hidden="true">
    <div class="raw-drawer-head">
      <div class="raw-drawer-title">
        <strong>Raw Messages</strong>
        <span id="rawDrawerMeta"></span>
      </div>
      <button id="rawDrawerClose" class="raw-drawer-close icon-button" type="button" aria-label="Close raw messages" title="Close raw messages"></button>
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
    const icons = {
      clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>',
      export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="M8 11l4 4 4-4"></path><path d="M4 21h16"></path></svg>',
      settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"></path></svg>',
      close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>',
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
      reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path></svg>',
      parts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4-8 4-8-4 8-4Z"></path><path d="M4 12l8 4 8-4"></path><path d="M4 17l8 4 8-4"></path></svg>',
      raw: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9L4 12l4 3"></path><path d="M16 9l4 3-4 3"></path><path d="M14 5l-4 14"></path></svg>'
    };
    let providers = [];
    let activeProviderId = '';
    let activeModelId = '';
    let inProgress = null;
    let isRunning = false;
    const toolCards = new Map();

    function setIconButton(button, icon, label) {
      button.innerHTML = icons[icon];
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }

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
        setIconButton(copyBtn, 'copy', 'Copy message');
        copyBtn.onclick = () => copyText(content);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'msg-action';
        setIconButton(resetBtn, 'reset', 'Reset to here');
        resetBtn.onclick = () => vscode.postMessage({ type: 'reset-to-step', messageId });

        actions.appendChild(copyBtn);
        actions.appendChild(resetBtn);
        if (Array.isArray(parts) && parts.length > 0) {
          const partsBtn = document.createElement('button');
          partsBtn.className = 'msg-action';
          setIconButton(partsBtn, 'parts', 'View message parts (' + parts.length + ')');
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
        setIconButton(button, 'raw', 'View raw messages');
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
      if (role === 'user') {
        const wrapper = document.createElement('div');
        wrapper.className = 'msg-wrap user';

        const div = document.createElement('div');
        div.className = 'msg ' + role;
        div.innerHTML = renderMarkdown(content);

        wrapper.appendChild(div);
        attachMessageActions(wrapper, role, content, rawMessageBatches, rawMessages, messageId, parts);
        messages.appendChild(wrapper);
        messages.scrollTop = messages.scrollHeight;
        return div;
      }

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

    setIconButton(document.getElementById('clear'), 'clear', 'Clear chat');
    setIconButton(document.getElementById('export'), 'export', 'Export chat');
    setIconButton(document.getElementById('settings'), 'settings', 'Open settings');
    setIconButton(rawDrawerClose, 'close', 'Close raw messages');

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
