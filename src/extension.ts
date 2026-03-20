import * as vscode from "vscode";
import { registerChatMessageHandler } from "./chat/chatController";
import { ChatSessionStore } from "./chat/sessionStore";
import { getChatWebviewHtml } from "./chat/chatWebview";
import { ChatMessage } from "./chat/types";
import { generateCommitMessage } from "./git/commitMessage";
import { openSettingsPanel } from "./settings/settingsPanel";

type ApiMode = "auto" | "chatCompletions" | "responses";
type StringMap = Record<string, string>;
type UnknownMap = Record<string, unknown>;

let chatView: vscode.WebviewView | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const sessionStore = new ChatSessionStore(context);

  const chatViewProvider = vscode.window.registerWebviewViewProvider("sidekick.chatView", {
    resolveWebviewView(webviewView) {
      chatView = webviewView;
      webviewView.webview.options = {
        enableScripts: true
      };
      webviewView.webview.html = getChatWebviewHtml();
      registerChatMessageHandler(webviewView.webview, context, sessionStore, requestChatCompletion);

      webviewView.onDidDispose(() => {
        chatView = undefined;
      });
    }
  });

  const configureModelCommand = vscode.commands.registerCommand("sidekick.configureModel", async () => {
    await openSettingsPanel(context);
  });

  const openSettingsCommand = vscode.commands.registerCommand("sidekick.openSettings", async () => {
    await openSettingsPanel(context);
  });

  const openChatCommand = vscode.commands.registerCommand("sidekick.openChat", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.sidekick");
    chatView?.show(false);
  });

  const generateCommitMessageCommand = vscode.commands.registerCommand("sidekick.generateCommitMessage", async () => {
    await generateCommitMessage(async (systemPrompt, userPrompt) => {
      return await requestChatCompletion(userPrompt, [], () => {
        // No-op: commit message generation uses final text only.
      }, systemPrompt);
    });
  });

  context.subscriptions.push(chatViewProvider);
  context.subscriptions.push(openChatCommand);
  context.subscriptions.push(configureModelCommand);
  context.subscriptions.push(openSettingsCommand);
  context.subscriptions.push(generateCommitMessageCommand);
}

export function deactivate(): void {
  // No-op
}

async function requestChatCompletion(
  userText: string,
  history: ChatMessage[],
  onDelta: (delta: string) => void,
  systemPromptOverride?: string
): Promise<string> {
  const config = vscode.workspace.getConfiguration("sidekick");
  const apiBaseUrl = config.get<string>("apiBaseUrl", "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = config.get<string>("apiKey", "").trim();
  const model = config.get<string>("model", "gpt-4o-mini");
  const promptCacheKey = config.get<string>("promptCacheKey", "").trim();
  const extraHeadersJson = config.get<string>("extraHeadersJson", "{}");
  const extraBodyJson = config.get<string>("extraBodyJson", "{}");
  const apiMode = config.get<ApiMode>("apiMode", "auto");
  const systemPrompt = (systemPromptOverride ?? config.get<string>("systemPrompt", "You are a helpful coding assistant.")).trim();

  const extraHeaders = parseStringJsonObject(extraHeadersJson, "sidekick.extraHeadersJson");
  const extraBody = parseUnknownJsonObject(extraBodyJson, "sidekick.extraBodyJson");

  if (!apiKey) {
    throw new Error("Please set sidekick.apiKey in VS Code settings.");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.filter((item) => item.role !== "system"),
    { role: "user", content: userText }
  ];

  if (model.toLowerCase().includes("gpt-5.3-codex") && !promptCacheKey) {
    throw new Error("This model requires sidekick.promptCacheKey. Please run 'Sidekick: Configure Model' and set it.");
  }

  if (apiMode === "chatCompletions") {
    return await callChatCompletions(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
  }

  if (apiMode === "responses") {
    return await callResponsesApi(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
  }

  try {
    return await callChatCompletions(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
  } catch (error) {
    if (shouldFallbackToResponses(error)) {
      return await callResponsesApi(apiBaseUrl, apiKey, model, messages, promptCacheKey, onDelta, extraHeaders, extraBody);
    }
    throw error;
  }
}

async function callChatCompletions(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  promptCacheKey: string,
  onDelta: (delta: string) => void,
  extraHeaders: StringMap,
  extraBody: UnknownMap
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true
  };

  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
  }

  Object.assign(body, extraBody);

  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(formatApiError(response.status, bodyText));
  }

  if (isEventStreamResponse(response)) {
    return await readSseResponse(response, onDelta);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("The model returned an empty response.");
  }

  return content;
}

async function callResponsesApi(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  promptCacheKey: string,
  onDelta: (delta: string) => void,
  extraHeaders: StringMap,
  extraBody: UnknownMap
): Promise<string> {
  const input = messages.map((item) => ({
    role: item.role,
    content: [
      {
        type: "input_text",
        text: item.content
      }
    ]
  }));

  const body: Record<string, unknown> = {
    model,
    input,
    stream: true
  };

  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
  }

  Object.assign(body, extraBody);

  const response = await fetch(`${apiBaseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(formatApiError(response.status, bodyText));
  }

  if (isEventStreamResponse(response)) {
    return await readSseResponse(response, onDelta);
  }

  const data = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  const directText = data.output_text?.trim();
  if (directText) {
    return directText;
  }

  for (const chunk of data.output ?? []) {
    for (const content of chunk.content ?? []) {
      if (content.type === "output_text" && content.text?.trim()) {
        return content.text.trim();
      }
    }
  }

  throw new Error("The model returned an empty response.");
}

function shouldFallbackToResponses(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const lower = error.message.toLowerCase();
  return lower.includes("responses api") || lower.includes("/v1/responses") || lower.includes("/responses");
}

function formatApiError(status: number, body: string): string {
  return `LLM request failed (${status}): ${body}`;
}

function parseUnknownJsonObject(raw: string, settingKey: string): UnknownMap {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must be a JSON object");
    }
    return value as UnknownMap;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${settingKey} ${message}`);
  }
}

function parseStringJsonObject(raw: string, settingKey: string): StringMap {
  const parsed = parseUnknownJsonObject(raw, settingKey);
  const headers: StringMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (value !== null && value !== undefined) {
      headers[key] = String(value);
    }
  }
  return headers;
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}

async function readSseResponse(response: Response, onDelta: (delta: string) => void): Promise<string> {
  if (!response.body) {
    throw new Error("Streaming response has no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        break;
      }

      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (dataLines.length === 0) {
        continue;
      }

      const payload = dataLines.join("\n");
      if (payload === "[DONE]") {
        continue;
      }

      const delta = extractDeltaText(payload);
      if (delta) {
        fullText += delta;
        onDelta(delta);
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error("The model returned an empty response.");
  }

  return fullText;
}

function extractDeltaText(payload: string): string {
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;

    if (typeof data.delta === "string") {
      return data.delta;
    }

    const choices = data.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const delta = first.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === "string") {
        return delta.content;
      }
    }

    const itemType = data.type;
    if (itemType === "response.output_text.delta" && typeof data.delta === "string") {
      return data.delta;
    }

    return "";
  } catch {
    return "";
  }
}
