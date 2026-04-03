import * as vscode from "vscode";
import { ModelProfile, ProviderConfig } from "./llm";

const SECTION = "sidekick";

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "openaiChat",
    label: "OpenAI Chat",
    apiType: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    defaultModel: "gpt-4o-mini",
    enabled: true,
    models: [
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        endpointType: "OPENAI",
      },
    ],
  },
  {
    id: "openaiResponses",
    label: "OpenAI Responses",
    apiType: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    defaultModel: "gpt-4o-mini",
    enabled: true,
    models: [
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        endpointType: "OPENAI_RESPONSE",
      },
    ],
  },
];

const DEFAULT_COMPLETION_PROFILE: ModelProfile = {
  providerId: "openaiChat",
  model: "gpt-4o-mini",
  temperature: 0.2,
  maxTokens: 512,
};

const DEFAULT_CHAT_PROFILE: ModelProfile = {
  providerId: "openaiChat",
  model: "gpt-4o-mini",
  temperature: 0.3,
  maxTokens: 4096,
};

const DEFAULT_AGENT_PROFILE: ModelProfile = {
  providerId: "openaiResponses",
  model: "gpt-4o-mini",
  temperature: 0.2,
  maxTokens: 4096,
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
}
