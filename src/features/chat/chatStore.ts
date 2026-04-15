import * as vscode from "vscode";
import { WorkspaceMutation } from "../../agent/builtinTools";
import { LlmContentPart, LlmMessage, RawMessageBatch } from "../../core/llm";

export type ChatMessagePart =
  | {
      id: string;
      type: "text";
      text: string;
      synthetic?: boolean;
      metadata?: Record<string, unknown>;
    }
  | {
      id: string;
      type: "file";
      filename: string;
      mime: string;
      url: string;
      synthetic?: boolean;
      metadata?: Record<string, unknown>;
    };

export interface ChatMessage {
  id: string;
  kind: "message";
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  parts?: ChatMessagePart[];
  rawMessages?: LlmMessage[];
  rawMessageBatches?: RawMessageBatch[];
  workspaceMutations?: WorkspaceMutation[];
}

export interface ToolActivityHistoryItem {
  kind: "tool_activity";
  id: string;
  phase: "start" | "end";
  name: string;
  detail: string;
  timestamp: number;
}

export type ChatHistoryItem = ChatMessage | ToolActivityHistoryItem;

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: string;
  model?: string;
  history: ChatHistoryItem[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatStoreState {
  sessions: ChatSession[];
  activeSessionId: string;
  currentView: ChatView;
  migrated: boolean;
}

export type ChatView = "chat" | "list";

export const DEFAULT_SESSION_TITLE = "New Chat";

const SESSIONS_KEY = "sidekick.chat.sessions";
const ACTIVE_SESSION_KEY = "sidekick.chat.activeSessionId";
const CURRENT_VIEW_KEY = "sidekick.chat.currentView";
const LEGACY_HISTORY_KEY = "sidekick.chat.history";
const LEGACY_SELECTION_KEY = "sidekick.chat.selection";

export interface ChatSelectionState {
  providerId: string;
  model?: string;
}

export class ChatStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  loadState(defaultProviderId: string, defaultModel?: string): ChatStoreState {
    const rawSessions = this.context.workspaceState.get<unknown[]>(SESSIONS_KEY, []);
    const sessions = normalizeSessions(rawSessions);
    const activeSessionId = String(
      this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY, "") || ""
    );
    const currentView = normalizeView(
      this.context.workspaceState.get<unknown>(CURRENT_VIEW_KEY, "chat")
    );

    if (sessions.length > 0) {
      return {
        sessions,
        activeSessionId: resolveActiveSessionId(sessions, activeSessionId),
        currentView,
        migrated: false,
      };
    }

    const legacyHistory = normalizeHistoryItems(
      this.context.workspaceState.get<unknown[]>(LEGACY_HISTORY_KEY, [])
    );
    const legacySelection = this.context.workspaceState.get<ChatSelectionState | undefined>(
      LEGACY_SELECTION_KEY
    );
    const fallbackProviderId = legacySelection?.providerId || defaultProviderId;
    const fallbackModel = legacySelection?.model || defaultModel;

    if (legacyHistory.length > 0) {
      const migratedSession = createSession(
        fallbackProviderId,
        fallbackModel,
        DEFAULT_SESSION_TITLE,
        legacyHistory
      );
      return {
        sessions: [migratedSession],
        activeSessionId: migratedSession.id,
        currentView,
        migrated: true,
      };
    }

    const initialSession = createSession(
      defaultProviderId,
      defaultModel,
      DEFAULT_SESSION_TITLE,
      []
    );
    return {
      sessions: [initialSession],
      activeSessionId: initialSession.id,
      currentView,
      migrated: true,
    };
  }

  async saveState(
    sessions: ChatSession[],
    activeSessionId: string,
    currentView: ChatView
  ): Promise<void> {
    await Promise.all([
      this.context.workspaceState.update(SESSIONS_KEY, sessions),
      this.context.workspaceState.update(ACTIVE_SESSION_KEY, activeSessionId),
      this.context.workspaceState.update(CURRENT_VIEW_KEY, currentView),
    ]);
  }

  async saveSessions(sessions: ChatSession[]): Promise<void> {
    await this.context.workspaceState.update(SESSIONS_KEY, sessions);
  }

  async saveActiveSessionId(activeSessionId: string): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_SESSION_KEY, activeSessionId);
  }

  async saveCurrentView(currentView: ChatView): Promise<void> {
    await this.context.workspaceState.update(CURRENT_VIEW_KEY, currentView);
  }
}

export function buildHistoryId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSession(
  providerId: string,
  model: string | undefined,
  title: string,
  history: ChatHistoryItem[]
): ChatSession {
  const now = Date.now();
  return {
    id: buildHistoryId("session"),
    title: String(title || DEFAULT_SESSION_TITLE),
    createdAt: now,
    updatedAt: deriveUpdatedAt(history, now),
    providerId,
    model,
    history,
  };
}

export function summarizeSession(session: ChatSession): ChatSessionSummary {
  const latestMessage = [...session.history]
    .reverse()
    .find((item): item is ChatMessage => item.kind === "message");

  return {
    id: session.id,
    title: session.title || DEFAULT_SESSION_TITLE,
    preview: buildSessionPreview(latestMessage),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function buildSessionPreview(message: ChatMessage | undefined): string {
  if (!message) {
    return "No messages yet";
  }
  return message.content.replace(/\s+/g, " ").trim().slice(0, 80) || "No messages yet";
}

function resolveActiveSessionId(sessions: ChatSession[], activeSessionId: string): string {
  if (sessions.some((session) => session.id === activeSessionId)) {
    return activeSessionId;
  }
  return sessions[0]?.id || "";
}

function normalizeView(raw: unknown): ChatView {
  return raw === "list" ? "list" : "chat";
}

function normalizeSessions(raw: unknown): ChatSession[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => normalizeSession(item))
    .filter((item): item is ChatSession => Boolean(item));
}

function normalizeSession(raw: unknown): ChatSession | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const history = normalizeHistoryItems((raw as { history?: unknown }).history);
  const createdAt = Number((raw as { createdAt?: unknown }).createdAt || Date.now());
  const updatedAt = Number(
    (raw as { updatedAt?: unknown }).updatedAt || deriveUpdatedAt(history, createdAt)
  );
  const providerId = String((raw as { providerId?: unknown }).providerId || "").trim();
  if (!providerId) {
    return undefined;
  }

  return {
    id: String((raw as { id?: unknown }).id || buildHistoryId("session")),
    title: String((raw as { title?: unknown }).title || DEFAULT_SESSION_TITLE),
    createdAt,
    updatedAt,
    providerId,
    model:
      typeof (raw as { model?: unknown }).model === "string"
        ? (raw as { model: string }).model
        : undefined,
    history,
  };
}

function deriveUpdatedAt(history: ChatHistoryItem[], fallback: number): number {
  return history.reduce((latest, item) => Math.max(latest, item.timestamp), fallback);
}

function normalizeHistoryItems(raw: unknown): ChatHistoryItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (item?.kind === "tool_activity") {
        return item as ToolActivityHistoryItem;
      }
      if (item?.kind === "message") {
        return {
          ...(item as ChatMessage),
          id: String(item.id || buildHistoryId("message")),
          parts: normalizeParts(item.parts),
          rawMessages: normalizeRawMessages(item.rawMessages),
          rawMessageBatches: normalizeRawMessageBatches(item.rawMessageBatches),
          workspaceMutations: normalizeWorkspaceMutations(item.workspaceMutations),
        } as ChatMessage;
      }
      if (item?.role === "user" || item?.role === "assistant") {
        return {
          id: buildHistoryId("message"),
          kind: "message",
          role: item.role,
          content: String(item.content || ""),
          timestamp: Number(item.timestamp || Date.now()),
          parts: normalizeParts(item.parts),
          rawMessages: normalizeRawMessages(item.rawMessages),
          rawMessageBatches: normalizeRawMessageBatches(item.rawMessageBatches),
          workspaceMutations: normalizeWorkspaceMutations(item.workspaceMutations),
        } as ChatMessage;
      }
      return undefined;
    })
    .filter((item): item is ChatHistoryItem => Boolean(item));
}

function normalizeParts(raw: unknown): ChatMessagePart[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const parts = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const id =
        typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : buildHistoryId("part");
      const type = (item as { type?: unknown }).type;
      const synthetic = Boolean((item as { synthetic?: unknown }).synthetic);
      const metadata =
        (item as { metadata?: unknown }).metadata &&
        typeof (item as { metadata?: unknown }).metadata === "object"
          ? (item as { metadata: Record<string, unknown> }).metadata
          : undefined;

      if (type === "text" && typeof (item as { text?: unknown }).text === "string") {
        return {
          id,
          type,
          text: (item as { text: string }).text,
          synthetic,
          metadata,
        } as ChatMessagePart;
      }

      if (
        type === "file" &&
        typeof (item as { filename?: unknown }).filename === "string" &&
        typeof (item as { mime?: unknown }).mime === "string" &&
        typeof (item as { url?: unknown }).url === "string"
      ) {
        return {
          id,
          type,
          filename: (item as { filename: string }).filename,
          mime: (item as { mime: string }).mime,
          url: (item as { url: string }).url,
          synthetic,
          metadata,
        } as ChatMessagePart;
      }

      return undefined;
    })
    .filter((item): item is ChatMessagePart => Boolean(item));

  return parts.length > 0 ? parts : undefined;
}

function normalizeRawMessages(raw: unknown): LlmMessage[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const messages = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const role = (item as { role?: unknown }).role;
      const content = normalizeLlmContent((item as { content?: unknown }).content);
      if (
        role !== "system" &&
        role !== "user" &&
        role !== "assistant" &&
        role !== "tool"
      ) {
        return undefined;
      }
      if (content === undefined) {
        return undefined;
      }

      const normalized: LlmMessage = {
        role,
        content,
      };
      if (typeof (item as { name?: unknown }).name === "string") {
        normalized.name = (item as { name: string }).name;
      }
      if (typeof (item as { toolCallId?: unknown }).toolCallId === "string") {
        normalized.toolCallId = (item as { toolCallId: string }).toolCallId;
      }
      return normalized;
    })
    .filter((item): item is LlmMessage => Boolean(item));

  return messages.length > 0 ? messages : undefined;
}

function normalizeLlmContent(raw: unknown): string | LlmContentPart[] | undefined {
  if (typeof raw === "string") {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const parts = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      if (
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        return {
          type: "text",
          text: (item as { text: string }).text,
          synthetic: Boolean((item as { synthetic?: unknown }).synthetic),
          metadata:
            typeof (item as { metadata?: unknown }).metadata === "object"
              ? (item as { metadata?: Record<string, unknown> }).metadata ?? undefined
              : undefined,
        } as LlmContentPart;
      }
      if (
        (item as { type?: unknown }).type === "file" &&
        typeof (item as { filename?: unknown }).filename === "string" &&
        typeof (item as { mime?: unknown }).mime === "string" &&
        typeof (item as { url?: unknown }).url === "string"
      ) {
        return {
          type: "file",
          filename: (item as { filename: string }).filename,
          mime: (item as { mime: string }).mime,
          url: (item as { url: string }).url,
          synthetic: Boolean((item as { synthetic?: unknown }).synthetic),
          metadata:
            typeof (item as { metadata?: unknown }).metadata === "object"
              ? (item as { metadata?: Record<string, unknown> }).metadata ?? undefined
              : undefined,
        } as LlmContentPart;
      }
      return undefined;
    })
    .filter((item): item is LlmContentPart => Boolean(item));

  return parts.length > 0 ? parts : undefined;
}

function normalizeRawMessageBatches(raw: unknown): RawMessageBatch[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const batches = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const title =
        typeof (item as { title?: unknown }).title === "string"
          ? (item as { title: string }).title
          : "Raw Messages";
      const messages = normalizeRawMessages((item as { messages?: unknown }).messages);
      if (!messages || messages.length === 0) {
        return undefined;
      }

      return { title, messages } satisfies RawMessageBatch;
    })
    .filter((item): item is RawMessageBatch => Boolean(item));

  return batches.length > 0 ? batches : undefined;
}

function normalizeWorkspaceMutations(raw: unknown): WorkspaceMutation[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const mutations = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const path = (item as { path?: unknown }).path;
      const existedBefore = (item as { existedBefore?: unknown }).existedBefore;
      if (typeof path !== "string" || typeof existedBefore !== "boolean") {
        return undefined;
      }

      return {
        path,
        existedBefore,
        previousContent:
          typeof (item as { previousContent?: unknown }).previousContent === "string"
            ? (item as { previousContent: string }).previousContent
            : undefined,
      } as WorkspaceMutation;
    })
    .filter((item): item is WorkspaceMutation => Boolean(item));

  return mutations.length > 0 ? mutations : undefined;
}
