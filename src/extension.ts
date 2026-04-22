import * as vscode from "vscode";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { CommitMessageLanguage, SidekickConfig } from "./core/config";
import { LlmGateway, ProviderConfig } from "./core/llm";
import { ChatPanelProvider } from "./features/chat/chatPanel";
import { SidekickInlineCompletionProvider } from "./features/inline/inlineProvider";
import { openSettingsPanel } from "./features/settings/settingsPanel";
import { McpManager } from "./mcp/mcpManager";
import { openMcpPanel } from "./features/mcp/mcpPanel";
import { openPermissionPanel } from "./features/permissions/permissionPanel";
import { openControlCenterPanel } from "./features/controlCenter/controlCenterPanel";

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext): void {
  const gateway = new LlmGateway(SidekickConfig.getProviders());
  const mcpManager = new McpManager();
  const inlineOutput = vscode.window.createOutputChannel("Sidekick Inline");
  const inlineProvider = new SidekickInlineCompletionProvider(
    gateway,
    inlineOutput
  );
  const chatPanel = new ChatPanelProvider(context, gateway, mcpManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, chatPanel),
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      inlineProvider
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("sidekick.providers")) {
        gateway.setProviders(SidekickConfig.getProviders());
        chatPanel.refreshProviders();
      }
      if (event.affectsConfiguration("sidekick.mcpServers")) {
        mcpManager.reloadFromConfig();
      }
    })
  );

  context.subscriptions.push(
    mcpManager,
    inlineOutput,
    vscode.commands.registerCommand("sidekick.acceptInlinePart", async () => {
      await vscode.commands.executeCommand(
        "editor.action.inlineSuggest.acceptNextWord"
      );
    }),
    vscode.commands.registerCommand("sidekick.rejectInline", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
    }),
    vscode.commands.registerCommand("sidekick.openChat", async () => {
      await chatPanel.focus();
    }),
    vscode.commands.registerCommand("sidekick.openControlCenter", async () => {
      await openControlCenterPanel("providers", mcpManager, () => {
        chatPanel.clearPermissionSession();
      });
    }),
    vscode.commands.registerCommand("sidekick.openSettings", async () => {
      await openSettingsPanel(mcpManager, () => {
        chatPanel.clearPermissionSession();
      });
    }),
    vscode.commands.registerCommand("sidekick.openMcpManager", async () => {
      await openMcpPanel(context.extensionUri, mcpManager, () => {
        chatPanel.clearPermissionSession();
      });
    }),
    vscode.commands.registerCommand("sidekick.openPermissionSettings", async () => {
      await openPermissionPanel(mcpManager, () => {
        chatPanel.clearPermissionSession();
      });
    }),
    vscode.commands.registerCommand("sidekick.explainCode", async () => {
      await chatPanel.promptAction(
        `Explain this code:\n\n${getSelectedText() || "(no selection)"}`
      );
    }),
    vscode.commands.registerCommand("sidekick.refactorSelection", async () => {
      await chatPanel.promptAction(
        `Refactor this code:\n\n${getSelectedText() || "(no selection)"}`
      );
    }),
    vscode.commands.registerCommand("sidekick.fixSelection", async () => {
      await chatPanel.promptAction(
        `Find and fix bugs in this code:\n\n${getSelectedText() || "(no selection)"}`
      );
    }),
    vscode.commands.registerCommand("sidekick.addTestsSelection", async () => {
      await chatPanel.promptAction(
        `Write tests for this code:\n\n${getSelectedText() || "(no selection)"}`
      );
    }),
    vscode.commands.registerCommand("sidekick.documentSelection", async () => {
      await chatPanel.promptAction(
        `Document this code:\n\n${getSelectedText() || "(no selection)"}`
      );
    }),
    vscode.commands.registerCommand("sidekick.testProviderConnection", async () => {
      await runProviderTest(gateway);
    }),
    vscode.commands.registerCommand("sidekick.openInlineLogs", async () => {
      inlineOutput.show(true);
    }),
    vscode.commands.registerCommand("sidekick.inlineDebugPing", async () => {
      await inlineProvider.debugPing();
      vscode.window.showInformationMessage("Inline debug ping finished.");
    }),
    vscode.commands.registerCommand("sidekick.generateCommitMessage", async () => {
      await generateCommitMessage(gateway, chatPanel);
    })
  );
}

export function deactivate(): void {}

function getSelectedText(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return "";
  }
  return editor.document.getText(editor.selection);
}

async function runProviderTest(gateway: LlmGateway): Promise<void> {
  const providers = gateway.getProviders();

  if (providers.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      "No Sidekick providers configured. Open settings now?",
      "Open Settings"
    );
    if (choice === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettingsJson",
        "@ext:sidekick.sidekick-ai-code-assistant sidekick.providers"
      );
    }
    return;
  }

  const selected = await pickProvider(providers);
  if (!selected) {
    return;
  }

  if (!selected.defaultModel) {
    vscode.window.showWarningMessage(
      "The selected provider has no default model. Configure a model first."
    );
    return;
  }

  const model = await vscode.window.showInputBox({
    title: "Model",
    prompt: "Model name to test",
    value: selected.defaultModel,
    ignoreFocusOut: true,
  });
  if (!model) {
    return;
  }

  const prompt = await vscode.window.showInputBox({
    title: "Prompt",
    prompt: "Test prompt sent to provider",
    value: "Reply with exactly: SIDEKICK_OK",
    ignoreFocusOut: true,
  });
  if (!prompt) {
    return;
  }

  const output = vscode.window.createOutputChannel("Sidekick Test");
  output.show(true);
  output.appendLine(`[provider] ${selected.id} (${selected.apiType})`);
  output.appendLine(`[model] ${model}`);
  output.appendLine("[stream]");

  let text = "";
  try {
    for await (const event of gateway.streamChat({
      profile: {
        providerId: selected.id,
        model,
        temperature: 0,
        maxTokens: 256,
      },
      messages: [{ role: "user", content: prompt }],
    })) {
      if (event.type === "text") {
        text += event.delta;
        output.append(event.delta);
      }
      if (event.type === "tool_call") {
        output.appendLine(`\n[tool_call] ${event.call.name}`);
      }
      if (event.type === "error") {
        output.appendLine(`\n[error] ${event.message}`);
      }
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Provider test failed: ${String(error)}`);
    return;
  }

  output.appendLine("\n\n[done]");
  const preview = text.trim().slice(0, 100);
  vscode.window.showInformationMessage(
    preview ? `Provider responded: ${preview}` : "Provider test completed."
  );
}

async function pickProvider(
  providers: ProviderConfig[]
): Promise<ProviderConfig | undefined> {
  const quickPick = await vscode.window.showQuickPick(
    providers.map((provider) => ({
      label: provider.label,
      description: provider.id,
      detail: `${provider.apiType} | ${provider.baseUrl}`,
      provider,
    })),
    {
      title: "Select provider",
      placeHolder: "Choose one configured provider",
      ignoreFocusOut: true,
    }
  );

  return quickPick?.provider;
}

async function generateCommitMessage(
  gateway: LlmGateway,
  chatPanel: ChatPanelProvider
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Sidekick: Generating commit message...",
    },
    async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        vscode.window.showWarningMessage("Open a workspace folder first.");
        return;
      }

      const providers = SidekickConfig.getProviders();
      const selected = chatPanel.getActiveProfile();
      const profile = {
        ...SidekickConfig.getChatProfile(),
        providerId: selected.providerId,
        model: selected.model,
      };

      if (!profile.providerId || !providers.some((item) => item.id === profile.providerId)) {
        vscode.window.showWarningMessage(
          "Current chat provider is not configured. Select a provider in the chat panel first."
        );
        return;
      }

      if (!profile.model) {
        vscode.window.showWarningMessage(
          "Current chat model is not configured. Select a model in the chat panel first."
        );
        return;
      }

      const selectedProvider = providers.find(
        (item) => item.id === profile.providerId
      );

      const cwd = folder.uri.fsPath;

      let staged = "";
      let unstaged = "";
      let recent = "";
      try {
        const [stagedResult, unstagedResult, recentResult] = await Promise.all([
          execAsync("git diff --cached", { cwd, maxBuffer: 1024 * 1024 * 6 }),
          execAsync("git diff", { cwd, maxBuffer: 1024 * 1024 * 6 }),
          execAsync("git log -5 --oneline", { cwd, maxBuffer: 1024 * 1024 }),
        ]);
        staged = stagedResult.stdout || "";
        unstaged = unstagedResult.stdout || "";
        recent = recentResult.stdout || "";
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to read git changes: ${String(error)}`);
        return;
      }

      if (!staged.trim() && !unstaged.trim()) {
        vscode.window.showInformationMessage("No git changes found.");
        return;
      }

      const hasStaged = Boolean(staged.trim());
      const diffSection = hasStaged
        ? ["Staged diff:", truncateForLlm(staged, 12000)]
        : [
            "Staged diff:",
            "(none)",
            "",
            "Unstaged diff:",
            truncateForLlm(unstaged, 12000),
          ];

      const prompt = [
        "Generate one concise git commit message.",
        "Requirements:",
        "- Output only plain text commit message, no markdown",
        "- Prefer format: type(scope): subject",
        "- Mention intent and impact briefly",
        "- Max 72 chars for subject, optional short body after blank line",
        ...getCommitMessageLanguageInstructions(
          SidekickConfig.getCommitMessageLanguage()
        ),
        "",
        "Recent commit style:",
        recent,
        "",
        ...diffSection,
      ].join("\n");

      let text = "";
      try {
        for await (const event of gateway.streamChat({
          profile,
          messages: [{ role: "user", content: prompt }],
          extraBody: buildNoThinkingParams(selectedProvider, profile.model),
        })) {
          if (event.type === "text") {
            text += event.delta;
          }
          if (event.type === "error") {
            vscode.window.showErrorMessage(
              `Commit message generation failed: ${event.message}`
            );
            return;
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Commit message generation failed: ${String(error)}`
        );
        return;
      }

      const message = sanitizeCommitMessage(text);
      if (!message) {
        vscode.window.showWarningMessage("Generated commit message was empty.");
        return;
      }

      const applied = await applyToGitInputBox(message);
      if (applied) {
        vscode.window.showInformationMessage("Commit message generated and filled.");
      } else {
        await vscode.env.clipboard.writeText(message);
        vscode.window.showInformationMessage(
          "Commit message copied to clipboard (Git input box unavailable)."
        );
      }
    }
  );
}

function truncateForLlm(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function getCommitMessageLanguageInstructions(
  language: CommitMessageLanguage
): string[] {
  if (language === "zh-CN") {
    return ["- Write the commit message in Simplified Chinese"];
  }

  if (language === "en") {
    return ["- Write the commit message in English"];
  }

  return [
    "- Use the same language as the recent commit style when it is clear",
    "- If the recent commit language is unclear, infer the best language from the diff",
  ];
}

function sanitizeCommitMessage(raw: string): string {
  const cleaned = raw
    .replace(/^```[\w-]*\s*/g, "")
    .replace(/```$/g, "")
    .trim();
  return cleaned;
}

function buildNoThinkingParams(
  provider: ProviderConfig | undefined,
  model: string | undefined
): Record<string, unknown> {
  if (!provider) {
    return {};
  }

  const vendor = detectVendor(provider, model);

  if (provider.apiType === "anthropic-messages") {
    return {
      thinking: { type: "disabled" },
    };
  }

  if (vendor === "glm") {
    return {
      thinking: { type: "disabled" },
      enable_thinking: false,
    };
  }

  if (vendor === "qwen") {
    return {
      enable_thinking: false,
    };
  }

  return {
    reasoning: { effort: "low" },
    reasoning_effort: "low",
  };
}

function detectVendor(
  provider: ProviderConfig,
  model: string | undefined
): "openai" | "glm" | "qwen" | "other" {
  const joined = [provider.id, provider.label, provider.baseUrl, model || ""]
    .join(" ")
    .toLowerCase();

  if (joined.includes("zhipu") || joined.includes("glm")) {
    return "glm";
  }
  if (joined.includes("qwen") || joined.includes("dashscope")) {
    return "qwen";
  }
  if (joined.includes("openai")) {
    return "openai";
  }
  return "other";
}

async function applyToGitInputBox(message: string): Promise<boolean> {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension) {
    return false;
  }

  if (!gitExtension.isActive) {
    await gitExtension.activate();
  }

  const api = gitExtension.exports?.getAPI?.(1);
  if (!api || !Array.isArray(api.repositories) || api.repositories.length === 0) {
    return false;
  }

  api.repositories[0].inputBox.value = message;
  return true;
}
