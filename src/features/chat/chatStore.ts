import * as vscode from "vscode";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

const HISTORY_KEY = "sidekick.chat.history";

export class ChatStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getHistory(): ChatMessage[] {
    return this.context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
  }

  async saveHistory(history: ChatMessage[]): Promise<void> {
    await this.context.workspaceState.update(HISTORY_KEY, history);
  }

  async clear(): Promise<void> {
    await this.context.workspaceState.update(HISTORY_KEY, []);
  }
}
