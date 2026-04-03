import * as vscode from "vscode";

export interface ChatMessage {
  kind: "message";
  role: "user" | "assistant";
  content: string;
  timestamp: number;
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

const HISTORY_KEY = "sidekick.chat.history";
const SELECTION_KEY = "sidekick.chat.selection";

export interface ChatSelectionState {
  providerId: string;
  model?: string;
}

export class ChatStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getHistory(): ChatHistoryItem[] {
    const raw = this.context.workspaceState.get<any[]>(HISTORY_KEY, []);
    return (raw || [])
      .map((item) => {
        if (item?.kind === "tool_activity") {
          return item as ToolActivityHistoryItem;
        }
        if (item?.kind === "message") {
          return item as ChatMessage;
        }
        if (item?.role === "user" || item?.role === "assistant") {
          return {
            kind: "message",
            role: item.role,
            content: String(item.content || ""),
            timestamp: Number(item.timestamp || Date.now()),
          } satisfies ChatMessage;
        }
        return undefined;
      })
      .filter((item): item is ChatHistoryItem => Boolean(item));
  }

  async saveHistory(history: ChatHistoryItem[]): Promise<void> {
    await this.context.workspaceState.update(HISTORY_KEY, history);
  }

  async clear(): Promise<void> {
    await this.context.workspaceState.update(HISTORY_KEY, []);
  }

  getSelection(): ChatSelectionState | undefined {
    return this.context.workspaceState.get<ChatSelectionState>(SELECTION_KEY);
  }

  async saveSelection(selection: ChatSelectionState): Promise<void> {
    await this.context.workspaceState.update(SELECTION_KEY, selection);
  }
}
