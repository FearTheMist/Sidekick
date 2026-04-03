import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { McpServerConfig } from "../core/config";
import { ToolDefinition } from "../core/llm";

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

export class McpClient {
  private process?: ChildProcessWithoutNullStreams;
  private id = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";

  constructor(private readonly config: McpServerConfig) {}

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    this.process = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.cwd,
      stdio: "pipe",
      shell: true,
    });

    this.process.stdout.on("data", (chunk: Buffer) => {
      this.onStdout(chunk.toString("utf8"));
    });

    this.process.on("exit", () => {
      for (const [, item] of this.pending) {
        item.reject(new Error("MCP process exited"));
      }
      this.pending.clear();
      this.process = undefined;
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "sidekick",
        version: "0.1.0",
      },
    });
  }

  async listTools(): Promise<ToolDefinition[]> {
    const response = await this.request("tools/list", {});
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    return tools.map((tool: any) => ({
      name: `${this.config.name}.${String(tool.name)}`,
      description: String(tool.description || "MCP tool"),
      inputSchema: tool.inputSchema || { type: "object", properties: {} },
    }));
  }

  async callTool(toolName: string, args: unknown): Promise<string> {
    const resolvedName = toolName.replace(`${this.config.name}.`, "");
    const response = await this.request("tools/call", {
      name: resolvedName,
      arguments: args,
    });

    if (!response?.content) {
      return JSON.stringify(response);
    }

    return JSON.stringify(response.content);
  }

  dispose(): void {
    this.process?.kill();
    this.pending.clear();
    this.process = undefined;
  }

  private onStdout(text: string): void {
    this.buffer += text;

    while (true) {
      const breakIndex = this.buffer.indexOf("\n");
      if (breakIndex < 0) {
        return;
      }

      const line = this.buffer.slice(0, breakIndex).trim();
      this.buffer = this.buffer.slice(breakIndex + 1);

      if (!line) {
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const id = Number(parsed.id);
      const pending = this.pending.get(id);
      if (!pending) {
        continue;
      }

      this.pending.delete(id);
      if (parsed.error) {
        pending.reject(new Error(String(parsed.error.message || "MCP error")));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  private async request(method: string, params: unknown): Promise<any> {
    if (!this.process) {
      throw new Error("MCP process not started");
    }

    const id = this.id++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
}
