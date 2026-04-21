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
export type PermissionPolicyAction = "allow" | "ask" | "deny";

export interface PermissionPolicyConfig {
  terminal_read: PermissionPolicyAction;
  terminal_project_exec: PermissionPolicyAction;
  terminal_project_mutation: PermissionPolicyAction;
  terminal_external_access: PermissionPolicyAction;
  terminal_network: PermissionPolicyAction;
  terminal_destructive: PermissionPolicyAction;
}

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

const DEFAULT_PERMISSION_POLICY: PermissionPolicyConfig = {
  terminal_read: "allow",
  terminal_project_exec: "ask",
  terminal_project_mutation: "ask",
  terminal_external_access: "ask",
  terminal_network: "ask",
  terminal_destructive: "ask",
};

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

  static getPermissionPolicy(): PermissionPolicyConfig {
    const value = vscode.workspace
      .getConfiguration(SECTION)
      .get<Partial<PermissionPolicyConfig>>("permissions", DEFAULT_PERMISSION_POLICY);

    return {
      terminal_read: this.normalizePermissionAction(value?.terminal_read),
      terminal_project_exec: this.normalizePermissionAction(
        value?.terminal_project_exec
      ),
      terminal_project_mutation: this.normalizePermissionAction(
        value?.terminal_project_mutation
      ),
      terminal_external_access: this.normalizePermissionAction(
        value?.terminal_external_access
      ),
      terminal_network: this.normalizePermissionAction(value?.terminal_network),
      terminal_destructive: this.normalizePermissionAction(
        value?.terminal_destructive
      ),
    };
  }

  static async savePermissionPolicy(
    policy: Partial<PermissionPolicyConfig>
  ): Promise<void> {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(
        "permissions",
        {
          terminal_read: this.normalizePermissionAction(policy.terminal_read),
          terminal_project_exec: this.normalizePermissionAction(
            policy.terminal_project_exec
          ),
          terminal_project_mutation: this.normalizePermissionAction(
            policy.terminal_project_mutation
          ),
          terminal_external_access: this.normalizePermissionAction(
            policy.terminal_external_access
          ),
          terminal_network: this.normalizePermissionAction(policy.terminal_network),
          terminal_destructive: this.normalizePermissionAction(
            policy.terminal_destructive
          ),
        },
        vscode.ConfigurationTarget.Global
      );
  }

  static getDefaultPermissionPolicy(): PermissionPolicyConfig {
    return { ...DEFAULT_PERMISSION_POLICY };
  }

  private static normalizePermissionAction(
    value: unknown
  ): PermissionPolicyAction {
    return value === "allow" || value === "deny" ? value : "ask";
  }
}
