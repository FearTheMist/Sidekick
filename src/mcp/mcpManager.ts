import * as vscode from "vscode";
import { McpClient } from "../agent/mcpClient";
import { McpServerConfig, SidekickConfig } from "../core/config";
import { ToolCall, ToolDefinition } from "../core/llm";

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

export interface McpServerState {
  config: McpServerConfig;
  status: McpConnectionStatus;
  error?: string;
  tools: ToolDefinition[];
}

export class McpManager implements vscode.Disposable {
  private readonly clients = new Map<string, McpClient>();
  private readonly states = new Map<string, McpServerState>();
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeState = this.emitter.event;

  constructor() {
    this.reloadFromConfig();
  }

  listStates(): McpServerState[] {
    return Array.from(this.states.values())
      .sort((left, right) => left.config.name.localeCompare(right.config.name))
      .map((state) => ({
        config: {
          ...state.config,
          headers: state.config.headers ? { ...state.config.headers } : undefined,
        },
        status: state.status,
        error: state.error,
        tools: [...state.tools],
      }));
  }

  getState(name: string): McpServerState | undefined {
    const state = this.states.get(name);
    if (!state) {
      return undefined;
    }

    return {
      config: {
        ...state.config,
        headers: state.config.headers ? { ...state.config.headers } : undefined,
      },
      status: state.status,
      error: state.error,
      tools: [...state.tools],
    };
  }

  reloadFromConfig(): void {
    const configs = SidekickConfig.getMcpServers();
    const nextNames = new Set(configs.map((item) => item.name));

    for (const [name, state] of this.states) {
      if (!nextNames.has(name) && state.status !== "connected" && state.status !== "connecting") {
        this.states.delete(name);
      }
    }

    for (const config of configs) {
      const existing = this.states.get(config.name);
      if (!existing) {
        this.states.set(config.name, {
          config,
          status: "disconnected",
          tools: [],
        });
        continue;
      }

      if (existing.status === "connected" || existing.status === "connecting") {
        continue;
      }

      existing.config = config;
      if (existing.status === "failed") {
        existing.tools = [];
      }
    }

    this.fireChange();
  }

  async addServer(input: McpServerConfig): Promise<void> {
    const servers = SidekickConfig.getMcpServers();
    const normalizedName = String(input.name || "").trim();
    if (servers.some((item) => item.name === normalizedName)) {
      throw new Error(`MCP server already exists: ${input.name}`);
    }
    const sanitized = SidekickConfig.sanitizeMcpServers([...servers, input]);
    if (!sanitized.some((item) => item.name === normalizedName)) {
      throw new Error("Invalid MCP server config.");
    }

    await SidekickConfig.saveMcpServers(sanitized);
    this.reloadFromConfig();
  }

  async updateServer(name: string, input: McpServerConfig): Promise<void> {
    const state = this.states.get(name);
    if (!state) {
      throw new Error(`MCP server not found: ${name}`);
    }
    if (state.status === "connected" || state.status === "connecting") {
      throw new Error("Disconnect the MCP server before editing it.");
    }

    const servers = SidekickConfig.getMcpServers();
    const normalizedName = String(input.name || "").trim();
    if (servers.some((item) => item.name === normalizedName && item.name !== name)) {
      throw new Error(`MCP server already exists: ${input.name}`);
    }
    const next = servers.map((item) => (item.name === name ? input : item));
    const sanitized = SidekickConfig.sanitizeMcpServers(next);
    if (!sanitized.some((item) => item.name === normalizedName)) {
      throw new Error("Invalid MCP server config.");
    }

    await SidekickConfig.saveMcpServers(sanitized);
    if (input.name !== name) {
      this.states.delete(name);
    }
    this.reloadFromConfig();
  }

  async removeServer(name: string): Promise<void> {
    const state = this.states.get(name);
    if (!state) {
      return;
    }
    if (state.status === "connected" || state.status === "connecting") {
      throw new Error("Disconnect the MCP server before deleting it.");
    }

    const servers = SidekickConfig.getMcpServers().filter((item) => item.name !== name);
    await SidekickConfig.saveMcpServers(servers);
    this.states.delete(name);
    this.fireChange();
  }

  async connect(name: string): Promise<McpServerState> {
    const state = this.states.get(name);
    if (!state) {
      throw new Error(`MCP server not found: ${name}`);
    }
    if (state.status === "connected") {
      return this.requireState(name);
    }
    if (state.status === "connecting") {
      return this.requireState(name);
    }

    state.status = "connecting";
    state.error = undefined;
    state.tools = [];
    this.fireChange();

    const client = new McpClient(state.config);
    try {
      await client.start();
      const tools = await client.listTools();
      this.clients.set(name, client);
      state.status = "connected";
      state.tools = tools;
      state.error = undefined;
    } catch (error) {
      client.dispose();
      state.status = "failed";
      state.tools = [];
      state.error = error instanceof Error ? error.message : String(error);
    }

    this.fireChange();
    return this.requireState(name);
  }

  async disconnect(name: string): Promise<void> {
    const state = this.states.get(name);
    if (!state) {
      return;
    }

    this.clients.get(name)?.dispose();
    this.clients.delete(name);
    state.status = "disconnected";
    state.error = undefined;
    state.tools = [];
    this.fireChange();
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.clients.keys());
    for (const name of names) {
      await this.disconnect(name);
    }
  }

  async refreshTools(name: string): Promise<ToolDefinition[]> {
    const client = this.clients.get(name);
    const state = this.states.get(name);
    if (!client || !state || state.status !== "connected") {
      throw new Error(`MCP server is not connected: ${name}`);
    }

    try {
      const tools = await client.listTools();
      state.tools = tools;
      state.error = undefined;
      this.fireChange();
      return tools;
    } catch (error) {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.tools = [];
      this.clients.delete(name);
      client.dispose();
      this.fireChange();
      throw error;
    }
  }

  getConnectedToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const state of this.states.values()) {
      if (state.status === "connected") {
        tools.push(...state.tools);
      }
    }
    return tools;
  }

  async callTool(call: ToolCall): Promise<string> {
    const [serverName] = call.name.split(".", 1);
    const client = this.clients.get(serverName);
    const state = this.states.get(serverName);
    if (!client || !state || state.status !== "connected") {
      throw new Error(`MCP server is not connected: ${serverName}`);
    }

    const args = JSON.parse(call.argumentsText || "{}");
    return client.callTool(call.name, args);
  }

  dispose(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }
    this.clients.clear();
    this.emitter.dispose();
  }

  private requireState(name: string): McpServerState {
    const state = this.getState(name);
    if (!state) {
      throw new Error(`MCP server not found: ${name}`);
    }
    return state;
  }

  private fireChange(): void {
    this.emitter.fire();
  }
}
