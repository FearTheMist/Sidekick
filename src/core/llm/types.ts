export type ProviderApiType =
  | "openai-chat"
  | "openai-responses"
  | "openai-compatible"
  | "anthropic-messages";

export type OpenAiCompatibleMode = "chat" | "responses";

export type ModelEndpointType =
  | "OPENAI"
  | "OPENAI_RESPONSE"
  | "OPENAI_RESPONSES"
  | "OPENAI_COMPATIBLE"
  | "OPENAI_COMPATIBLE_RESPONSE"
  | "OPENAI_COMPATIBLE_RESPONSES"
  | "ANTHROPIC"
  | "ANTHROPIC_MESSAGES";

export interface ProviderModelConfig {
  id: string;
  name: string;
  endpointType: ModelEndpointType;
}

export interface ProviderConfig {
  id: string;
  label: string;
  apiType: ProviderApiType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  compatibleMode?: OpenAiCompatibleMode;
  models?: ProviderModelConfig[];
}

export interface ModelProfile {
  providerId: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "tool_activity";
      id: string;
      phase: "start" | "end";
      name: string;
      detail: string;
    }
  | { type: "error"; message: string }
  | { type: "done" };

export interface StreamRequest {
  profile: ModelProfile;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}
