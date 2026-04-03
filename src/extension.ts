import * as vscode from "vscode";
import { SidekickConfig } from "./core/config";
import { LlmGateway, ProviderConfig } from "./core/llm";
import { ChatPanelProvider } from "./features/chat/chatPanel";
import { SidekickInlineCompletionProvider } from "./features/inline/inlineProvider";
import { openSettingsPanel } from "./features/settings/settingsPanel";

export function activate(context: vscode.ExtensionContext): void {
  const gateway = new LlmGateway(SidekickConfig.getProviders());
  const inlineOutput = vscode.window.createOutputChannel("Sidekick Inline");
  const inlineProvider = new SidekickInlineCompletionProvider(
    gateway,
    inlineOutput
  );
  const chatPanel = new ChatPanelProvider(context, gateway);

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
      }
    })
  );

  context.subscriptions.push(
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
    vscode.commands.registerCommand("sidekick.openSettings", async () => {
      await openSettingsPanel();
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
