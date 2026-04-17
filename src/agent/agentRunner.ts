import { SidekickConfig } from "../core/config";
import {
  LlmGateway,
  LlmMessage,
  ModelProfile,
  RawMessageBatch,
  StreamEvent,
  ToolCall,
} from "../core/llm";
import { createBuiltinToolRuntime, WorkspaceMutation } from "./builtinTools";
import { McpManager } from "../mcp/mcpManager";
import { ToolAuthorizationGate } from "./toolAuth";

const MAX_AGENT_STEPS = 4;

export class AgentRunner {
  private readonly authGate = new ToolAuthorizationGate();

  constructor(
    private readonly gateway: LlmGateway,
    private readonly mcpManager: McpManager
  ) {}

  async *run(
    messages: LlmMessage[],
    overrideProfile?: Partial<ModelProfile>,
    signal?: AbortSignal,
    workspaceMutations?: WorkspaceMutation[]
  ): AsyncGenerator<StreamEvent> {
    const runtime = createBuiltinToolRuntime(this.authGate, {
      mutations: workspaceMutations || [],
    });
    const mcpTools = this.mcpManager.getConnectedToolDefinitions();
    const tools = [...runtime.definitions, ...mcpTools];

    let workingMessages = [...messages];

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      if (signal?.aborted) {
        return;
      }

      const profile = {
        ...SidekickConfig.getAgentProfile(),
        ...(overrideProfile || {}),
      };

      const toolCalls: ToolCall[] = [];

      yield {
        type: "request_messages",
        batch: this.buildRequestBatch(step, workingMessages),
      };

      for await (const event of this.gateway.streamChat({
        profile,
        messages: workingMessages,
        tools,
        signal,
      })) {
        if (event.type === "tool_call") {
          toolCalls.push(event.call);
          continue;
        }
        yield event;
      }

      if (toolCalls.length === 0) {
        return;
      }

      for (const call of toolCalls) {
        if (signal?.aborted) {
          return;
        }

        yield {
          type: "tool_activity",
          id: call.id,
          phase: "start",
          name: call.name,
          detail: this.describeToolCall(call),
        };

        const result = call.name.includes(".")
          ? await this.runMcpTool(call)
          : await runtime.runTool(call.name, call.argumentsText);

        yield {
          type: "tool_activity",
          id: call.id,
          phase: "end",
          name: call.name,
          detail: this.summarizeToolResult(result),
        };

        workingMessages.push({
          role: "assistant",
          content: `Calling tool ${call.name}`,
        });
        workingMessages.push({
          role: "tool",
          content: result,
          name: call.name,
          toolCallId: call.id,
        });

        if (signal?.aborted) {
          return;
        }
      }
    }
  }

  private async runMcpTool(call: ToolCall): Promise<string> {
    const allowed = await this.authGate.authorize(call.name, call.argumentsText);
    if (!allowed) {
      return "Denied";
    }

    try {
      return await this.mcpManager.callTool(call);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private describeToolCall(call: ToolCall): string {
    let args: any;
    try {
      args = JSON.parse(call.argumentsText || "{}");
    } catch {
      return call.argumentsText || "{}";
    }

    if (call.name === "run_terminal_command") {
      return `command=${String(args.command || "")}`;
    }

    const path = args.path ? `path=${String(args.path)}` : "";
    const query = args.query ? `query=${String(args.query)}` : "";
    const name = args.name ? `name=${String(args.name)}` : "";

    const detail = [path, query, name].filter(Boolean).join(" ");
    if (detail) {
      return detail;
    }

    const compact = JSON.stringify(args);
    return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
  }

  private summarizeToolResult(result: string): string {
    const oneLine = result.replace(/\s+/g, " ").trim();
    if (!oneLine) {
      return "(empty result)";
    }
    return oneLine.length > 200 ? `${oneLine.slice(0, 200)}...` : oneLine;
  }

  private buildRequestBatch(step: number, messages: LlmMessage[]): RawMessageBatch {
    return {
      title: step === 0 ? "Initial request" : `Round ${step + 1}`,
      messages: messages.map((message) => ({ ...message })),
    };
  }
}
