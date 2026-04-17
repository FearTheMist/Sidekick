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
    return (
      vscode.workspace
        .getConfiguration(SECTION)
        .get<McpServerConfig[]>("mcpServers", []) || []
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
