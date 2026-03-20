import * as vscode from "vscode";
import { ChatSession, ChatSessionSummary, SessionMessage } from "./types";

const CHAT_SESSIONS_KEY = "sidekick.chatSessions";
const ACTIVE_CHAT_SESSION_KEY = "sidekick.activeChatSession";

export class ChatSessionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async ensureSeeded(): Promise<void> {
    const sessions = this.loadSessions();
    if (sessions.length === 0) {
      await this.saveSessions([createEmptySession()]);
    }
  }

  async getHomeState(): Promise<{ sessions: ChatSessionSummary[] }> {
    await this.ensureSeeded();
    const sessions = this.loadSessions();
    return { sessions: toSummaries(sessions) };
  }

  async getChatState(sessionId: string): Promise<{ sessions: ChatSessionSummary[]; session: ChatSession | undefined }> {
    await this.ensureSeeded();
    const sessions = this.loadSessions();
    const session = sessions.find((item) => item.id === sessionId);
    return {
      sessions: toSummaries(sessions),
      session
    };
  }

  async getActiveSession(): Promise<ChatSession> {
    await this.ensureSeeded();
    const sessions = this.loadSessions();
    const activeSessionId = await this.ensureActiveSessionId(sessions);
    return sessions.find((item) => item.id === activeSessionId) ?? sessions[0];
  }

  async createSession(): Promise<ChatSession> {
    const sessions = this.loadSessions();
    const session = createEmptySession();
    sessions.unshift(session);
    sortSessionsByRecent(sessions);
    await this.saveSessions(sessions);
    await this.context.workspaceState.update(ACTIVE_CHAT_SESSION_KEY, session.id);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    let sessions = this.loadSessions().filter((item) => item.id !== sessionId);
    if (sessions.length === 0) {
      sessions = [createEmptySession()];
    }

    sortSessionsByRecent(sessions);
    await this.saveSessions(sessions);

    const activeSessionId = this.context.workspaceState.get<string>(ACTIVE_CHAT_SESSION_KEY, "");
    const stillExists = sessions.some((item) => item.id === activeSessionId);
    if (!stillExists) {
      await this.context.workspaceState.update(ACTIVE_CHAT_SESSION_KEY, sessions[0].id);
    }
  }

  async setActiveSession(sessionId: string): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_CHAT_SESSION_KEY, sessionId);
  }

  async appendUserMessage(sessionId: string, text: string): Promise<ChatSession | undefined> {
    const sessions = this.loadSessions();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      return undefined;
    }

    session.messages.push({ role: "user", content: text });
    session.title = generateSessionTitle(session.messages);
    session.updatedAt = Date.now();
    sortSessionsByRecent(sessions);
    await this.saveSessions(sessions);
    await this.context.workspaceState.update(ACTIVE_CHAT_SESSION_KEY, session.id);
    return session;
  }

  async appendAssistantMessage(sessionId: string, text: string): Promise<ChatSession | undefined> {
    const sessions = this.loadSessions();
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      return undefined;
    }

    session.messages.push({ role: "assistant", content: text });
    session.updatedAt = Date.now();
    sortSessionsByRecent(sessions);
    await this.saveSessions(sessions);
    return session;
  }

  private async ensureActiveSessionId(sessions: ChatSession[]): Promise<string> {
    const current = this.context.workspaceState.get<string>(ACTIVE_CHAT_SESSION_KEY, "");
    const found = sessions.some((item) => item.id === current);
    if (found) {
      return current;
    }

    const fallback = sessions[0].id;
    await this.context.workspaceState.update(ACTIVE_CHAT_SESSION_KEY, fallback);
    return fallback;
  }

  private loadSessions(): ChatSession[] {
    const raw = this.context.globalState.get<unknown>(CHAT_SESSIONS_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }

    const sessions: ChatSession[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as Partial<ChatSession>;
      if (typeof record.id !== "string" || !record.id) {
        continue;
      }

      const messages = normalizeSessionMessages(record.messages);
      sessions.push({
        id: record.id,
        title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : generateSessionTitle(messages),
        createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
        messages
      });
    }

    sortSessionsByRecent(sessions);
    return sessions;
  }

  private async saveSessions(sessions: ChatSession[]): Promise<void> {
    await this.context.globalState.update(CHAT_SESSIONS_KEY, sessions);
  }
}

function toSummaries(sessions: ChatSession[]): ChatSessionSummary[] {
  return sessions.map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt }));
}

function createEmptySession(): ChatSession {
  const now = Date.now();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    title: "New Chat",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

function normalizeSessionMessages(rawMessages: unknown): SessionMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const normalized: SessionMessage[] = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const message = raw as Partial<SessionMessage>;
    if ((message.role === "user" || message.role === "assistant") && typeof message.content === "string") {
      const text = message.content.trim();
      if (text) {
        normalized.push({ role: message.role, content: text });
      }
    }
  }

  return normalized;
}

function generateSessionTitle(messages: SessionMessage[]): string {
  const firstUserMessage = messages.find((item) => item.role === "user");
  if (!firstUserMessage) {
    return "New Chat";
  }

  const collapsed = firstUserMessage.content.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "New Chat";
  }

  return collapsed.length > 36 ? `${collapsed.slice(0, 36)}...` : collapsed;
}

function sortSessionsByRecent(sessions: ChatSession[]): void {
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
