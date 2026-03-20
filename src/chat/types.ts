export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type SessionMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
};

export type ChatSessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
};
