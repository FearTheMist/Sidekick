import {
  LlmMessage,
  ProviderConfig,
  StreamEvent,
  StreamRequest,
  ToolCall,
} from "./types";
import { readSse } from "./sse";

interface ResolvedRequest {
  provider: ProviderConfig;
  model: string;
  messages: LlmMessage[];
  tools: StreamRequest["tools"];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

type FetchFn = typeof fetch;

export class LlmGateway {
  private providerMap = new Map<string, ProviderConfig>();

  constructor(
    providers: ProviderConfig[] = [],
    private readonly fetchFn: FetchFn = fetch
  ) {
    this.setProviders(providers);
  }

  setProviders(providers: ProviderConfig[]): void {
    this.providerMap = new Map(
      providers
        .filter((provider) => provider.enabled !== false)
        .map((provider) => [provider.id, provider])
    );
  }

  getProviders(): ProviderConfig[] {
    return [...this.providerMap.values()];
  }

  async *streamChat(request: StreamRequest): AsyncGenerator<StreamEvent> {
    const resolved = this.resolveRequest(request);

    switch (resolved.provider.apiType) {
      case "openai-chat":
        yield* this.streamOpenAiChat(resolved);
        return;
      case "openai-responses":
        yield* this.streamOpenAiResponses(resolved);
        return;
      case "openai-compatible":
        if (resolved.provider.compatibleMode === "responses") {
          yield* this.streamOpenAiResponses(resolved);
          return;
        }
        yield* this.streamOpenAiChat(resolved);
        return;
      case "anthropic-messages":
        yield* this.streamAnthropicMessages(resolved);
        return;
      default:
        yield {
          type: "error",
          message: `Unsupported provider type: ${String(resolved.provider.apiType)}`,
        };
        yield { type: "done" };
    }
  }

  private resolveRequest(request: StreamRequest): ResolvedRequest {
    const provider = this.providerMap.get(request.profile.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${request.profile.providerId}`);
    }

    return {
      provider,
      model: request.profile.model || provider.defaultModel,
      messages: request.messages,
      tools: request.tools,
      temperature: request.profile.temperature,
      maxTokens: request.profile.maxTokens,
      signal: request.signal,
    };
  }

  private async *streamOpenAiChat(
    request: ResolvedRequest
  ): AsyncGenerator<StreamEvent> {
    const endpoint = this.buildUrl(request.provider.baseUrl, "/chat/completions");
    const body: Record<string, unknown> = {
      model: request.model,
      stream: true,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      })),
      ...(request.provider.body || {}),
    };

    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }
    if (typeof request.maxTokens === "number") {
      body.max_tokens = request.maxTokens;
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    const response = await this.fetchFn(endpoint, {
      method: "POST",
      headers: this.jsonHeaders(request.provider),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      yield {
        type: "error",
        message: `HTTP ${response.status}: ${await response.text()}`,
      };
      yield { type: "done" };
      return;
    }

    const toolChunks = new Map<number, ToolCall>();

    for await (const packet of readSse(response)) {
      if (packet.data === "[DONE]") {
        yield { type: "done" };
        return;
      }

      const json = this.safeParse(packet.data);
      if (!json) {
        continue;
      }

      const choice = json.choices?.[0];
      const delta = choice?.delta;

      if (typeof delta?.content === "string") {
        yield { type: "text", delta: delta.content };
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const index = Number(raw.index || 0);
          const existing = toolChunks.get(index) || {
            id: String(raw.id || `tool-${index}`),
            name: "",
            argumentsText: "",
          };

          existing.id = String(raw.id || existing.id);
          existing.name = String(raw.function?.name || existing.name);
          existing.argumentsText += String(raw.function?.arguments || "");
          toolChunks.set(index, existing);
        }
      }

      if (choice?.finish_reason === "tool_calls" && toolChunks.size > 0) {
        for (const call of toolChunks.values()) {
          yield { type: "tool_call", call };
        }
        toolChunks.clear();
      }
    }

    if (toolChunks.size > 0) {
      for (const call of toolChunks.values()) {
        yield { type: "tool_call", call };
      }
    }
    yield { type: "done" };
  }

  private async *streamOpenAiResponses(
    request: ResolvedRequest
  ): AsyncGenerator<StreamEvent> {
    const endpoint = this.buildUrl(request.provider.baseUrl, "/responses");
    const body: Record<string, unknown> = {
      model: request.model,
      stream: true,
      input: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(request.provider.body || {}),
    };

    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }
    if (typeof request.maxTokens === "number") {
      body.max_output_tokens = request.maxTokens;
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
    }

    const response = await this.fetchFn(endpoint, {
      method: "POST",
      headers: this.jsonHeaders(request.provider),
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      yield {
        type: "error",
        message: `HTTP ${response.status}: ${await response.text()}`,
      };
      yield { type: "done" };
      return;
    }

    const calls = new Map<string, ToolCall>();

    for await (const packet of readSse(response)) {
      if (packet.data === "[DONE]") {
        break;
      }

      const json = this.safeParse(packet.data);
      if (!json) {
        continue;
      }

      if (json.type === "response.output_text.delta" && typeof json.delta === "string") {
        yield { type: "text", delta: json.delta };
        continue;
      }

      if (json.type === "response.output_item.added" && json.item?.type === "function_call") {
        const id = String(json.item.id || json.item_id || "tool-call");
        calls.set(id, {
          id,
          name: String(json.item.name || "tool"),
          argumentsText: String(json.item.arguments || ""),
        });
        continue;
      }

      if (json.type === "response.function_call_arguments.delta") {
        const id = String(json.item_id || "tool-call");
        const current = calls.get(id) || { id, name: String(json.name || "tool"), argumentsText: "" };
        current.argumentsText += String(json.delta || "");
        if (json.name) {
          current.name = String(json.name);
        }
        calls.set(id, current);
        continue;
      }

      if (json.type === "response.function_call_arguments.done") {
        const id = String(json.item_id || "tool-call");
        const call = calls.get(id);
        if (call) {
          if (typeof json.arguments === "string") {
            call.argumentsText = json.arguments;
          }
          yield { type: "tool_call", call };
          calls.delete(id);
        }
        continue;
      }

      if (json.type === "response.output_item.done" && json.item?.type === "function_call") {
        const id = String(json.item.id || json.item_id || "tool-call");
        const call = calls.get(id) || {
          id,
          name: String(json.item.name || "tool"),
          argumentsText: String(json.item.arguments || "{}"),
        };
        if (typeof json.item.arguments === "string") {
          call.argumentsText = json.item.arguments;
        }
        yield { type: "tool_call", call };
        calls.delete(id);
      }
    }

    for (const call of calls.values()) {
      yield { type: "tool_call", call };
    }
    yield { type: "done" };
  }

  private async *streamAnthropicMessages(
    request: ResolvedRequest
  ): AsyncGenerator<StreamEvent> {
    const endpoint = this.buildUrl(request.provider.baseUrl, "/messages");
    const body: Record<string, unknown> = {
      model: request.model,
      stream: true,
      max_tokens: request.maxTokens ?? 2048,
      messages: request.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: message.content })),
      ...(request.provider.body || {}),
    };

    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": request.provider.apiKey,
      ...(request.provider.headers || {}),
    };

    const response = await this.fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      yield {
        type: "error",
        message: `HTTP ${response.status}: ${await response.text()}`,
      };
      yield { type: "done" };
      return;
    }

    const toolBlocks = new Map<number, ToolCall>();

    for await (const packet of readSse(response)) {
      if (packet.data === "[DONE]") {
        break;
      }

      const json = this.safeParse(packet.data);
      if (!json) {
        continue;
      }

      if (json.type === "content_block_delta" && typeof json.delta?.text === "string") {
        yield { type: "text", delta: json.delta.text };
        continue;
      }

      if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
        const index = Number(json.index || 0);
        toolBlocks.set(index, {
          id: String(json.content_block.id || `tool-${index}`),
          name: String(json.content_block.name || "tool"),
          argumentsText: "",
        });
        continue;
      }

      if (
        json.type === "content_block_delta" &&
        json.delta?.type === "input_json_delta" &&
        typeof json.delta?.partial_json === "string"
      ) {
        const index = Number(json.index || 0);
        const call = toolBlocks.get(index);
        if (call) {
          call.argumentsText += json.delta.partial_json;
        }
        continue;
      }

      if (json.type === "content_block_stop") {
        const index = Number(json.index || 0);
        const call = toolBlocks.get(index);
        if (call) {
          yield { type: "tool_call", call };
          toolBlocks.delete(index);
        }
      }
    }

    for (const call of toolBlocks.values()) {
      yield { type: "tool_call", call };
    }
    yield { type: "done" };
  }

  private jsonHeaders(provider: ProviderConfig): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.headers || {}),
    };
  }

  private safeParse(data: string): any | undefined {
    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  private buildUrl(baseUrl: string, path: string): string {
    if (!baseUrl) {
      throw new Error("Provider baseUrl is required");
    }
    return `${baseUrl.replace(/\/$/, "")}${path}`;
  }
}
