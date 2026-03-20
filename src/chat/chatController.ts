import * as vscode from "vscode";
import { buildSelectionContextPrompt, getCurrentEditorSelectionContext, toSelectionHint } from "./editorContext";
import { ChatSessionStore } from "./sessionStore";
import { ChatMessage } from "./types";

type IncomingMessage = {
  type: string;
  text?: string;
  sessionId?: string;
  createSession?: boolean;
};

type RequestChatCompletion = (
  userText: string,
  history: ChatMessage[],
  onDelta: (delta: string) => void
) => Promise<string>;

export function registerChatMessageHandler(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  sessionStore: ChatSessionStore,
  requestChatCompletion: RequestChatCompletion
): void {
  webview.onDidReceiveMessage(
    async (message: IncomingMessage) => {
      if (message.type === "configure") {
        await vscode.commands.executeCommand("sidekick.configureModel");
        return;
      }

      if (message.type === "ready") {
        await postHomeState(webview, sessionStore);
        postEditorContext(webview);
        return;
      }

      if (message.type === "newSession") {
        const session = await sessionStore.createSession();
        await postChatState(webview, sessionStore, session.id);
        return;
      }

      if (message.type === "openSession") {
        const sessionId = (message.sessionId ?? "").trim();
        if (!sessionId) {
          return;
        }
        await sessionStore.setActiveSession(sessionId);
        await postChatState(webview, sessionStore, sessionId);
        return;
      }

      if (message.type === "deleteSession") {
        const sessionId = (message.sessionId ?? "").trim();
        if (!sessionId) {
          return;
        }

        await sessionStore.deleteSession(sessionId);
        await postHomeState(webview, sessionStore);
        return;
      }

      if (message.type !== "send") {
        return;
      }

      const userText = (message.text ?? "").trim();
      if (!userText) {
        webview.postMessage({ type: "error", text: "Message cannot be empty." });
        return;
      }

      const editorContext = getCurrentEditorSelectionContext();
      const finalPrompt = editorContext
        ? `${userText}\n\n${buildSelectionContextPrompt(editorContext)}`
        : userText;

      const requestedSessionId = (message.sessionId ?? "").trim();
      const activeSession = requestedSessionId
        ? (await sessionStore.getChatState(requestedSessionId)).session
        : await sessionStore.getActiveSession();
      const targetSession =
        requestedSessionId || message.createSession || !activeSession ? await sessionStore.createSession() : activeSession;
      const targetSessionId = targetSession.id;

      const updatedAfterUser = await sessionStore.appendUserMessage(targetSessionId, userText);
      if (!updatedAfterUser) {
        webview.postMessage({ type: "error", text: "Session not found." });
        return;
      }

      await postChatState(webview, sessionStore, targetSessionId);

      try {
        webview.postMessage({ type: "assistantStart" });
        const historyBeforePrompt = updatedAfterUser.messages.slice(0, -1) as ChatMessage[];
        const reply = await requestChatCompletion(finalPrompt, historyBeforePrompt, (delta) => {
          webview.postMessage({ type: "assistantDelta", text: delta });
        });

        await sessionStore.appendAssistantMessage(targetSessionId, reply);
        webview.postMessage({ type: "assistantDone", text: reply });
        await postChatState(webview, sessionStore, targetSessionId);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        webview.postMessage({ type: "error", text });
      }
    },
    undefined,
    context.subscriptions
  );
}

async function postHomeState(webview: vscode.Webview, sessionStore: ChatSessionStore): Promise<void> {
  const homeState = await sessionStore.getHomeState();
  webview.postMessage({
    type: "homeState",
    sessions: homeState.sessions
  });
}

export function postEditorContext(webview: vscode.Webview): void {
  const context = getCurrentEditorSelectionContext();
  webview.postMessage({
    type: "editorContext",
    context: toSelectionHint(context) ?? null
  });
}

async function postChatState(webview: vscode.Webview, sessionStore: ChatSessionStore, sessionId: string): Promise<void> {
  const chatState = await sessionStore.getChatState(sessionId);
  if (!chatState.session) {
    await postHomeState(webview, sessionStore);
    return;
  }

  webview.postMessage({
    type: "chatState",
    sessions: chatState.sessions,
    activeSessionId: chatState.session.id,
    title: chatState.session.title,
    messages: chatState.session.messages
  });
}
