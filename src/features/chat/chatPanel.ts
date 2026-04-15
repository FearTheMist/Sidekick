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
  ChatView,
  ChatSession,
  ChatSessionSummary,
  ChatMessagePart,
  ChatHistoryItem,
  ChatMessage,
  ChatStore,
  DEFAULT_SESSION_TITLE,
  createSession,
  summarizeSession,
} from "./chatStore";

type IncomingMessage =
  | { type: "ready" }
  | { type: "send"; text: string; providerId?: string; model?: string }
  | { type: "stop" }
  | { type: "reset-to-step"; messageId: string }
  | { type: "selection"; providerId?: string; model?: string }
  | { type: "view"; view: ChatView }
  | { type: "new-session" }
  | { type: "open-session"; sessionId: string }
  | { type: "delete-session"; sessionId: string }
  | { type: "clear" }
  | { type: "export" }
  | { type: "open-settings" };

type OutgoingMessage =
  | {
      type: "hydrate";
      history: ChatHistoryItem[];
      sessions: ChatSessionSummary[];
      activeSessionId: string;
      activeSessionTitle: string;
      currentView: ChatView;
      providers: ProviderConfig[];
      profileProviderId: string;
      profileModel: string;
    }
  | {
      type: "session-meta";
      sessions: ChatSessionSummary[];
      activeSessionId: string;
      activeSessionTitle: string;
      currentView: ChatView;
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
  private sessions: ChatSession[];
  private activeSessionId: string;
  private currentView: ChatView;
  private readonly migratedState: boolean;
  private readonly pendingTitleSessions = new Set<string>();
  private activeRun?: AbortController;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly gateway: LlmGateway
  ) {
    this.store = new ChatStore(context);
    this.agentRunner = new AgentRunner(gateway);
    const profile = SidekickConfig.getChatProfile();
    const state = this.store.loadState(profile.providerId, profile.model);
    this.sessions = state.sessions;
    this.activeSessionId = state.activeSessionId;
    this.currentView = state.currentView;
    this.migratedState = state.migrated;
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
    const session = this.getActiveSession();
    return {
      providerId: session.providerId,
      model: session.model,
    };
  }

  refreshProviders(): void {
    this.ensureValidSessionSelections(SidekickConfig.getProviders());
    void this.store.saveSessions(this.sessions);
    this.postHydrate();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    if (this.migratedState) {
      await this.store.saveState(this.sessions, this.activeSessionId, this.currentView);
    }

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (raw: IncomingMessage) => {
      switch (raw.type) {
        case "ready": {
          this.postHydrate();
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
          const session = this.getActiveSession();
          if (raw.providerId) {
            session.providerId = raw.providerId;
          }
          if (typeof raw.model === "string") {
            session.model = raw.model;
          }
          this.ensureValidSessionSelection(session, SidekickConfig.getProviders());
          await this.store.saveSessions(this.sessions);
          this.postSessionMeta();
          break;
        }
        case "view": {
          this.currentView = raw.view === "list" ? "list" : "chat";
          await this.store.saveCurrentView(this.currentView);
          break;
        }
        case "new-session": {
          if (this.activeRun) {
            vscode.window.showInformationMessage("Wait for the current reply to finish before switching sessions.");
            break;
          }
          await this.createAndOpenSession();
          break;
        }
        case "open-session": {
          if (this.activeRun) {
            vscode.window.showInformationMessage("Wait for the current reply to finish before switching sessions.");
            break;
          }
          const exists = this.sessions.some((session) => session.id === raw.sessionId);
          if (!exists) {
            break;
          }
          this.activeSessionId = raw.sessionId;
          await this.store.saveActiveSessionId(this.activeSessionId);
          this.postHydrate();
          break;
        }
        case "delete-session": {
          if (this.activeRun) {
            vscode.window.showInformationMessage("Wait for the current reply to finish before switching sessions.");
            break;
          }
          await this.deleteSession(raw.sessionId);
          break;
        }
        case "clear": {
          const session = this.getActiveSession();
          session.history = [];
          session.title = DEFAULT_SESSION_TITLE;
          session.updatedAt = Date.now();
          await this.store.saveSessions(this.sessions);
          this.postHydrate();
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

    const session = this.getActiveSession();
    const hadMessages = session.history.some((item) => item.kind === "message");
    if (providerId) {
      session.providerId = providerId;
    }
    if (model) {
      session.model = model;
    }
    this.ensureValidSessionSelection(session, SidekickConfig.getProviders());

    const userMessage: ChatMessage = {
      id: buildHistoryId("message"),
      kind: "message",
      role: "user",
      content: text,
      timestamp: Date.now(),
      parts: this.buildUserMessageParts(text),
    };
    session.history.push(userMessage);
    session.updatedAt = userMessage.timestamp;
    void this.store.saveSessions(this.sessions);
    this.postSessionMeta();
    this.post({ type: "append", message: userMessage });
    if (!hadMessages && session.title === DEFAULT_SESSION_TITLE) {
      void this.generateSessionTitle(session.id, text);
    }

    const snapshot = await collectContext(text);
    const contextPrompt = toContextPrompt(snapshot);

    const profile = {
      ...SidekickConfig.getChatProfile(),
      providerId: session.providerId,
      model: session.model,
    };

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
      ...session.history
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
          session.history.push({
            kind: "tool_activity",
            id: event.id,
            phase: event.phase,
            name: event.name,
            detail: event.detail,
            timestamp: Date.now(),
          });
          session.updatedAt = Date.now();
          void this.store.saveSessions(this.sessions);
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

    session.history.push(assistantMessage);
    session.updatedAt = assistantMessage.timestamp;
    await this.store.saveSessions(this.sessions);
    this.postSessionMeta();
    this.post({ type: "assistant-finalize", message: assistantMessage });
    this.post({ type: "assistant-end" });
  }

  private async exportHistory(): Promise<void> {
    const session = this.getActiveSession();
    const uri = await vscode.window.showSaveDialog({
      saveLabel: "Export Chat",
      filters: { Markdown: ["md"] },
      defaultUri: vscode.Uri.file("sidekick-chat.md"),
    });

    if (!uri) {
      return;
    }

    const markdown = session.history
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
    const session = this.getActiveSession();
    const targetIndex = session.history.findIndex(
      (item) => item.kind === "message" && item.id === messageId && item.role === "user"
    );
    if (targetIndex === -1) {
      return;
    }

    const target = session.history[targetIndex] as ChatMessage;
    const rollback = session.history
      .slice(targetIndex)
      .filter(
        (item): item is ChatMessage => item.kind === "message" && item.role === "user"
      )
      .flatMap((item) => item.workspaceMutations || []);

    await this.rollbackWorkspaceMutations(rollback);
    session.history = session.history.slice(0, targetIndex);
    session.title = session.history.length > 0 ? session.title : DEFAULT_SESSION_TITLE;
    session.updatedAt = Date.now();
    await this.store.saveSessions(this.sessions);
    this.postHydrate();
    this.post({ type: "seed", text: target.content });
  }

  private getActiveSession(): ChatSession {
    this.ensureSessionExists();
    let session = this.sessions.find((item) => item.id === this.activeSessionId);
    if (!session) {
      session = this.sessions[0];
      this.activeSessionId = session.id;
    }
    this.ensureValidSessionSelection(session, SidekickConfig.getProviders());
    return session;
  }

  private ensureSessionExists(): void {
    if (this.sessions.length > 0) {
      return;
    }
    const profile = SidekickConfig.getChatProfile();
    const session = createSession(
      profile.providerId,
      profile.model,
      DEFAULT_SESSION_TITLE,
      []
    );
    this.sessions = [session];
    this.activeSessionId = session.id;
  }

  private ensureValidSessionSelections(providers: ProviderConfig[]): void {
    this.ensureSessionExists();
    this.sessions.forEach((session) => this.ensureValidSessionSelection(session, providers));
    if (!this.sessions.some((session) => session.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
    }
  }

  private ensureValidSessionSelection(
    session: ChatSession,
    providers: ProviderConfig[]
  ): void {
    if (providers.length === 0) {
      session.providerId = "";
      session.model = "";
      return;
    }

    let provider = providers.find((item) => item.id === session.providerId);
    if (!provider) {
      provider = providers[0];
      session.providerId = provider.id;
    }

    const models = provider.models || [];
    if (models.length === 0) {
      session.model = provider.defaultModel || session.model || "";
      return;
    }

    if (!models.some((item) => item.id === session.model)) {
      session.model = models[0].id;
    }
  }

  private async createAndOpenSession(): Promise<void> {
    const current = this.getActiveSession();
    const profile = SidekickConfig.getChatProfile();
    const session = createSession(
      current.providerId || profile.providerId,
      current.model || profile.model,
      DEFAULT_SESSION_TITLE,
      []
    );
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    await this.store.saveState(this.sessions, this.activeSessionId, this.currentView);
    this.postHydrate();
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const targetIndex = this.sessions.findIndex((session) => session.id === sessionId);
    if (targetIndex === -1) {
      return;
    }

    this.sessions.splice(targetIndex, 1);
    this.pendingTitleSessions.delete(sessionId);

    if (this.sessions.length === 0) {
      const profile = SidekickConfig.getChatProfile();
      const fallback = createSession(
        profile.providerId,
        profile.model,
        DEFAULT_SESSION_TITLE,
        []
      );
      this.sessions = [fallback];
      this.activeSessionId = fallback.id;
    } else if (this.activeSessionId === sessionId) {
      const nextSession = this.sessions[Math.max(0, targetIndex - 1)] || this.sessions[0];
      this.activeSessionId = nextSession.id;
    }

    await this.store.saveState(this.sessions, this.activeSessionId, this.currentView);
    this.postHydrate();
  }

  private getSessionSummaries(): ChatSessionSummary[] {
    return this.sessions
      .map((session) => summarizeSession(session))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private postHydrate(): void {
    const providers = SidekickConfig.getProviders();
    this.ensureValidSessionSelections(providers);
    const session = this.getActiveSession();
    this.post({
      type: "hydrate",
      history: session.history,
      sessions: this.getSessionSummaries(),
      activeSessionId: session.id,
      activeSessionTitle: session.title,
      currentView: this.currentView,
      providers,
      profileProviderId: session.providerId,
      profileModel: session.model || "",
    });
  }

  private postSessionMeta(): void {
    const providers = SidekickConfig.getProviders();
    this.ensureValidSessionSelections(providers);
    const session = this.getActiveSession();
    this.post({
      type: "session-meta",
      sessions: this.getSessionSummaries(),
      activeSessionId: session.id,
      activeSessionTitle: session.title,
      currentView: this.currentView,
      profileProviderId: session.providerId,
      profileModel: session.model || "",
    });
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

  private postSelectionContext(): void {
    this.post({
      type: "selection-context",
      location: getSelectedLocation(vscode.window.activeTextEditor),
    });
  }

  private async generateSessionTitle(sessionId: string, firstMessage: string): Promise<void> {
    if (!firstMessage.trim() || this.pendingTitleSessions.has(sessionId)) {
      return;
    }

    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session || session.title !== DEFAULT_SESSION_TITLE) {
      return;
    }

    const provider = SidekickConfig.getProviders().find(
      (item) => item.id === session.providerId
    );
    if (!provider) {
      return;
    }

    this.pendingTitleSessions.add(sessionId);
    try {
      const profile = {
        ...SidekickConfig.getChatProfile(),
        providerId: session.providerId,
        model: session.model,
        temperature: 0.2,
        maxTokens: 48,
      };
      const prompt = [
        "Generate one concise chat title.",
        "Requirements:",
        "- Output only the title text",
        "- No quotes",
        "- No punctuation at the end",
        "- Max 12 words",
      ].join("\n");

      let text = "";
      for await (const event of this.gateway.streamChat({
        profile,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: firstMessage },
        ],
        extraBody: buildNoThinkingParams(provider, profile.model),
      })) {
        if (event.type === "text") {
          text += event.delta;
        }
        if (event.type === "error") {
          return;
        }
      }

      const title = sanitizeSessionTitle(text);
      const target = this.sessions.find((item) => item.id === sessionId);
      if (!title || !target || target.title !== DEFAULT_SESSION_TITLE) {
        return;
      }
      target.title = title;
      await this.store.saveSessions(this.sessions);
      this.postSessionMeta();
    } catch {
      // Leave the default title when title generation fails.
    } finally {
      this.pendingTitleSessions.delete(sessionId);
    }
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
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      padding: 8px 12px 6px;
      background: rgba(7, 8, 10, 0.72);
      backdrop-filter: blur(12px);
    }
    .toolbar-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
    }
    .toolbar-left {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
    }
    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: none;
    }
    .screen {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .screen.hidden {
      display: none;
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
    .stop-btn svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
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
    .session-list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .session-item {
      width: 100%;
      text-align: left;
      padding: 12px;
      border-radius: 14px;
      border: 1px solid var(--stroke-soft);
      background: rgba(16, 17, 17, 0.88);
      box-shadow: var(--ring);
    }
    .session-item-shell {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
    }
    .session-item-main {
      min-width: 0;
      border: none;
      background: transparent;
      box-shadow: none;
      padding: 0;
      text-align: left;
      color: inherit;
    }
    .session-item-delete {
      width: 28px;
      min-width: 28px;
      height: 28px;
      min-height: 28px;
      margin: -2px -2px 0 0;
    }
    .session-item-title {
      font-size: 13px;
      font-weight: 600;
    }
    .session-item-preview {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    .session-item-meta {
      margin-top: 8px;
      color: var(--dim);
      font-size: 11px;
    }
    .session-list-empty {
      margin: auto 0;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
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
  <section id="chatScreen" class="screen">
    <div class="toolbar">
      <div class="toolbar-left">
        <button id="goBack" class="icon-button" type="button" aria-label="Go back" title="Go back"></button>
        <div id="sessionTitle" class="toolbar-title">New Chat</div>
      </div>
      <div class="toolbar-actions">
        <button id="clear" class="icon-button" type="button" aria-label="Clear chat" title="Clear chat"></button>
        <button id="export" class="icon-button" type="button" aria-label="Export chat" title="Export chat"></button>
        <button id="settings" class="icon-button" type="button" aria-label="Open settings" title="Open settings"></button>
      </div>
    </div>
    <div id="messages"></div>
    <div id="modelPicker" class="model-picker hidden"></div>
    <div class="input">
      <div id="selectionContext" class="selection-context hidden"></div>
      <div class="input-shell">
        <textarea id="input" placeholder="Ask Sidekick..."></textarea>
        <div class="model-row">
          <button id="modelPickerBtn">Model: -</button>
          <button id="stop" class="stop-btn" aria-label="Send" title="Send" type="button"></button>
        </div>
      </div>
    </div>
  </section>
  <section id="sessionListScreen" class="screen hidden">
    <div class="toolbar">
      <div class="toolbar-title">Sessions</div>
      <div class="toolbar-actions">
        <button id="newSession" class="icon-button" type="button" aria-label="New chat" title="New chat"></button>
      </div>
    </div>
    <div id="sessionList" class="session-list"></div>
  </section>
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
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const chatScreen = document.getElementById('chatScreen');
    const sessionListScreen = document.getElementById('sessionListScreen');
    const sessionTitle = document.getElementById('sessionTitle');
    const sessionList = document.getElementById('sessionList');
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
    const goBackBtn = document.getElementById('goBack');
    const newSessionBtn = document.getElementById('newSession');
    const clearBtn = document.getElementById('clear');
    const exportBtn = document.getElementById('export');
    const settingsBtn = document.getElementById('settings');
    const icons = {
      trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>',
      plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',
      back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>',
      clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>',
      export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="M8 11l4 4 4-4"></path><path d="M4 21h16"></path></svg>',
      settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"></path></svg>',
      close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>',
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
      reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 3v6h6"></path></svg>',
      parts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4-8 4-8-4 8-4Z"></path><path d="M4 12l8 4 8-4"></path><path d="M4 17l8 4 8-4"></path></svg>',
      raw: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9L4 12l4 3"></path><path d="M16 9l4 3-4 3"></path><path d="M14 5l-4 14"></path></svg>',
      send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4 20-7Z"></path></svg>',
      pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14"></path><path d="M16 5v14"></path></svg>'
    };
    let providers = [];
    let sessions = [];
    let activeSessionId = '';
    let activeProviderId = '';
    let activeModelId = '';
    let currentView = 'chat';
    let pendingView = '';
    let inProgress = null;
    let isRunning = false;
    const toolCards = new Map();

    function setIconButton(button, icon, label) {
      button.innerHTML = icons[icon];
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }

    function showView(view) {
      currentView = view;
      chatScreen.classList.toggle('hidden', view !== 'chat');
      sessionListScreen.classList.toggle('hidden', view !== 'list');
      vscode.postMessage({ type: 'view', view });
      if (view !== 'chat') {
        modelPicker.classList.add('hidden');
        closeRawDrawer();
      }
    }

    function formatUpdatedAt(timestamp) {
      if (!timestamp) {
        return '';
      }
      const date = new Date(timestamp);
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      return isToday
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function renderSessionList() {
      sessionList.innerHTML = '';
      if (!Array.isArray(sessions) || sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'session-list-empty';
        empty.textContent = 'No chats yet';
        sessionList.appendChild(empty);
        return;
      }

      sessions.forEach((item) => {
        const itemShell = document.createElement('div');
        itemShell.className = 'session-item session-item-shell';

        const button = document.createElement('button');
        button.className = 'session-item-main';
        button.type = 'button';
        button.onclick = () => {
          pendingView = 'chat';
          vscode.postMessage({ type: 'open-session', sessionId: item.id });
        };

        const title = document.createElement('div');
        title.className = 'session-item-title';
        title.textContent = item.title || 'New Chat';

        const preview = document.createElement('div');
        preview.className = 'session-item-preview';
        preview.textContent = item.preview || 'No messages yet';

        const meta = document.createElement('div');
        meta.className = 'session-item-meta';
        meta.textContent = formatUpdatedAt(item.updatedAt);

        button.appendChild(title);
        button.appendChild(preview);
        button.appendChild(meta);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'icon-button session-item-delete';
        deleteBtn.type = 'button';
        setIconButton(deleteBtn, 'trash', 'Delete chat');
        deleteBtn.onclick = (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: 'delete-session', sessionId: item.id });
        };

        itemShell.appendChild(button);
        itemShell.appendChild(deleteBtn);
        sessionList.appendChild(itemShell);
      });
    }

    function applySessionMeta(msg) {
      sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      activeSessionId = msg.activeSessionId || '';
      sessionTitle.textContent = msg.activeSessionTitle || 'New Chat';
      renderSessionList();
    }

    function syncInputHeight() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 300) + 'px';
      input.style.overflowY = input.scrollHeight > 300 ? 'auto' : 'hidden';
    }

    function setRunState(nextRunning) {
      isRunning = nextRunning;
      stopBtn.disabled = false;
      setIconButton(stopBtn, nextRunning ? 'pause' : 'send', nextRunning ? 'Stop' : 'Send');
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

    function setSelection(preferredProviderId, preferredModelId, shouldEmit) {
      const provider = providers.find((item) => item.id === preferredProviderId) || providers[0];
      activeProviderId = provider ? provider.id : '';

      const models = Array.isArray(provider?.models) ? provider.models : [];
      if (models.length === 0) {
        activeModelId = preferredModelId || provider?.defaultModel || '';
      } else {
        const selected = models.find((item) => item.id === preferredModelId) || models[0];
        activeModelId = selected.id;
      }

      if (shouldEmit) {
        emitSelection();
      }
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

    setIconButton(goBackBtn, 'back', 'Go back');
    setIconButton(newSessionBtn, 'plus', 'New chat');
    setIconButton(clearBtn, 'clear', 'Clear chat');
    setIconButton(exportBtn, 'export', 'Export chat');
    setIconButton(settingsBtn, 'settings', 'Open settings');
    setIconButton(rawDrawerClose, 'close', 'Close raw messages');
    setIconButton(stopBtn, 'send', 'Send');

    goBackBtn.onclick = () => showView('list');
    newSessionBtn.onclick = () => {
      pendingView = 'chat';
      vscode.postMessage({ type: 'new-session' });
    };
    clearBtn.onclick = () => vscode.postMessage({ type: 'clear' });
    exportBtn.onclick = () => vscode.postMessage({ type: 'export' });
    settingsBtn.onclick = () => vscode.postMessage({ type: 'open-settings' });
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
      if (msg.type === 'hydrate') {
        messages.innerHTML = '';
        toolCards.clear();
        inProgress = null;
        setRunState(false);
        providers = Array.isArray(msg.providers) ? msg.providers : [];
        applySessionMeta(msg);
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
        setSelection(msg.profileProviderId || '', msg.profileModel || '', false);
        showView(pendingView || msg.currentView || currentView);
        pendingView = '';
      }

      if (msg.type === 'session-meta') {
        applySessionMeta(msg);
        setSelection(msg.profileProviderId || '', msg.profileModel || '', false);
        currentView = msg.currentView || currentView;
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
        messages.scrollTop = messages.scrollHeight;
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
        messages.scrollTop = messages.scrollHeight;
      }

      if (msg.type === 'tool-activity') {
        appendToolActivity(msg.id || msg.name, msg.phase, msg.name, msg.detail);
      }

      if (msg.type === 'assistant-end') {
        inProgress = null;
        setRunState(false);
      }

      if (msg.type === 'seed') {
        showView('chat');
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

function sanitizeSessionTitle(raw: string): string {
  return raw
    .replace(/^```[\w-]*\s*/g, "")
    .replace(/```$/g, "")
    .replace(/["'`]/g, "")
    .split(/\r?\n/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function buildNoThinkingParams(
  provider: ProviderConfig | undefined,
  model: string | undefined
): Record<string, unknown> {
  if (!provider) {
    return {};
  }

  const vendor = detectVendor(provider, model);

  if (provider.apiType === "anthropic-messages") {
    return {
      thinking: { type: "disabled" },
    };
  }

  if (vendor === "glm") {
    return {
      thinking: { type: "disabled" },
      enable_thinking: false,
    };
  }

  if (vendor === "qwen") {
    return {
      enable_thinking: false,
    };
  }

  return {
    reasoning: { effort: "low" },
    reasoning_effort: "low",
  };
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
