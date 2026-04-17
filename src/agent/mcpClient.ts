import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServerConfig } from "../core/config";
import { ToolDefinition } from "../core/llm";

export class McpClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;

  constructor(private readonly config: McpServerConfig) {}

  get name(): string {
    return this.config.name;
  }

  async start(): Promise<void> {
    if (this.client) {
      return;
    }

    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: this.config.headers
        ? {
            headers: this.config.headers,
          }
        : undefined,
    });
    const client = new Client({
      name: "sidekick",
      version: "0.1.0",
    });

    try {
      await client.connect(transport, {
        timeout: this.config.timeout,
      });
      this.transport = transport;
      this.client = client;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.client) {
      throw new Error("MCP client not started");
    }

    const response = await this.client.listTools({
      cursor: undefined,
    }, {
      timeout: this.config.timeout,
    });
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    return tools.map((tool: any) => ({
      name: `${this.config.name}.${String(tool.name)}`,
      description: String(tool.description || "MCP tool"),
      inputSchema: tool.inputSchema || { type: "object", properties: {} },
    }));
  }

  async callTool(toolName: string, args: unknown): Promise<string> {
    if (!this.client) {
      throw new Error("MCP client not started");
    }

    const resolvedName = toolName.replace(`${this.config.name}.`, "");
    const argumentsObject =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const response = await this.client.callTool({
      name: resolvedName,
      arguments: argumentsObject,
    }, undefined, {
      timeout: this.config.timeout,
    });

    if (!response?.content) {
      return JSON.stringify(response);
    }

    return JSON.stringify(response.content);
  }

  dispose(): void {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    void client?.close().catch(() => undefined);
    void transport?.close().catch(() => undefined);
  }
}
