import * as vscode from "vscode";
import { ModelProfile, ProviderConfig } from "./llm";

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
}

export type CommitMessageLanguage = "auto" | "zh-CN" | "en";

const SECTION = "sidekick";

const DEFAULT_PROVIDERS: ProviderConfig[] = [];

const DEFAULT_COMPLETION_PROFILE: ModelProfile = {
  providerId: "",
  model: "",
  temperature: 0.2,
  maxTokens: 512,
};

const DEFAULT_CHAT_PROFILE: ModelProfile = {
  providerId: "",
  model: "",
  temperature: 0.3,
  maxTokens: 4096,
};

const DEFAULT_AGENT_PROFILE: ModelProfile = {
  providerId: "",
  model: "",
  temperature: 0.2,
  maxTokens: 4096,
};

const DEFAULT_COMMIT_MESSAGE_LANGUAGE: CommitMessageLanguage = "auto";

export class SidekickConfig {
  static getProviderSettings(): ProviderConfig[] {
    return (
      vscode.workspace
        .getConfiguration(SECTION)
        .get<ProviderConfig[]>("providers", DEFAULT_PROVIDERS) || []
    );
  }

  static getProviders(): ProviderConfig[] {
    const raw = this.getProviderSettings();
    return (raw || []).filter((provider) => provider.enabled !== false);
  }

  static getCompletionProfile(): ModelProfile {
    return vscode.workspace
      .getConfiguration(SECTION)
      .get<ModelProfile>("completionProfile", DEFAULT_COMPLETION_PROFILE);
  }

  static getChatProfile(): ModelProfile {
    return vscode.workspace
      .getConfiguration(SECTION)
      .get<ModelProfile>("chatProfile", DEFAULT_CHAT_PROFILE);
  }

  static getAgentProfile(): ModelProfile {
    return vscode.workspace
      .getConfiguration(SECTION)
      .get<ModelProfile>("agentProfile", DEFAULT_AGENT_PROFILE);
  }

  static getMcpServers(): McpServerConfig[] {
    return this.sanitizeMcpServers(
      vscode.workspace.getConfiguration(SECTION).get<McpServerConfig[]>("mcpServers", []) || []
    );
  }

  static sanitizeMcpServers(input: McpServerConfig[]): McpServerConfig[] {
    const seen = new Set<string>();
    const output: McpServerConfig[] = [];

    for (const item of input || []) {
      const name = String(item?.name || "").trim();
      const url = String(item?.url || "").trim();
      if (!name || !url || seen.has(name)) {
        continue;
      }

      seen.add(name);

      const headers = Object.fromEntries(
        Object.entries(item?.headers || {}).filter(([key, value]) => {
          return key.trim().length > 0 && String(value).trim().length > 0;
        })
      );
      const timeoutValue = Number(item?.timeout);

      output.push({
        name,
        url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        timeout:
          Number.isFinite(timeoutValue) && timeoutValue > 0
            ? Math.floor(timeoutValue)
            : undefined,
        enabled: item?.enabled !== false,
      });
    }

    return output;
  }

  static async saveMcpServers(servers: McpServerConfig[]): Promise<void> {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(
        "mcpServers",
        this.sanitizeMcpServers(servers),
        vscode.ConfigurationTarget.Global
      );
  }

  static getCommitMessageLanguage(): CommitMessageLanguage {
    const value = vscode.workspace
      .getConfiguration(SECTION)
      .get<CommitMessageLanguage>(
        "commitMessageLanguage",
        DEFAULT_COMMIT_MESSAGE_LANGUAGE
      );

    if (value === "zh-CN" || value === "en") {
      return value;
    }

    return "auto";
  }
}
