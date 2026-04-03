import { SidekickConfig } from "../core/config";
import {
  LlmGateway,
  LlmMessage,
  ModelProfile,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "../core/llm";
import { createBuiltinToolRuntime } from "./builtinTools";
import { McpClient } from "./mcpClient";
import { ToolAuthorizationGate } from "./toolAuth";

const MAX_AGENT_STEPS = 4;

export class AgentRunner {
  private readonly authGate = new ToolAuthorizationGate();

  constructor(private readonly gateway: LlmGateway) {}

  async *run(
    messages: LlmMessage[],
    overrideProfile?: Partial<ModelProfile>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const runtime = createBuiltinToolRuntime(this.authGate);
    const mcpClients = await this.startMcpClients();
    const mcpTools = await this.collectMcpTools(mcpClients);
    const tools = [...runtime.definitions, ...mcpTools];

    let workingMessages = [...messages];

    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        const profile = {
          ...SidekickConfig.getAgentProfile(),
          ...(overrideProfile || {}),
        };

        const toolCalls: ToolCall[] = [];

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
          const result = call.name.includes(".")
            ? await this.runMcpTool(mcpClients, call)
            : await runtime.runTool(call.name, call.argumentsText);

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
        }
      }
    } finally {
      for (const client of mcpClients) {
        client.dispose();
      }
    }
  }

  private async startMcpClients(): Promise<McpClient[]> {
    const servers = SidekickConfig.getMcpServers().filter(
      (server) => server.enabled !== false
    );

    const clients: McpClient[] = [];
    for (const server of servers) {
      try {
        const client = new McpClient(server);
        await client.start();
        clients.push(client);
      } catch {
        continue;
      }
    }

    return clients;
  }

  private async collectMcpTools(clients: McpClient[]): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    for (const client of clients) {
      try {
        tools.push(...(await client.listTools()));
      } catch {
        continue;
      }
    }
    return tools;
  }

  private async runMcpTool(clients: McpClient[], call: ToolCall): Promise<string> {
    for (const client of clients) {
      try {
        const allowed = await this.authGate.authorize(call.name, call.argumentsText);
        if (!allowed) {
          return "Denied";
        }

        const args = JSON.parse(call.argumentsText || "{}");
        return await client.callTool(call.name, args);
      } catch {
        continue;
      }
    }

    return `MCP tool not found: ${call.name}`;
  }
}
