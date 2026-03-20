export function getChatWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sidekick Chat</title>
  <style>
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, sans-serif;
      height: 100vh;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    #root {
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .hidden {
      display: none !important;
    }
    #homeScreen {
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    #homeHeader,
    #chatHeader {
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    #homeTitle,
    #chatTitle {
      font-size: 12px;
      opacity: 0.85;
      letter-spacing: 0.2px;
      font-weight: 600;
    }
    .toolbarButton {
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      padding: 4px 10px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 12px;
    }
    .toolbarButton:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #homeSessionList {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .sessionItem {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: transparent;
      cursor: pointer;
    }
    .sessionItem:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .sessionTitle {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .deleteSession {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 12px;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      line-height: 16px;
      text-align: center;
      padding: 0;
    }
    .deleteSession:hover {
      color: var(--vscode-errorForeground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .empty {
      opacity: 0.75;
      font-size: 12px;
      text-align: center;
      padding: 28px 10px;
    }
    #homeComposer,
    #chatComposer {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    #homeInput,
    #chatInput {
      flex: 1;
      height: 100px;
      resize: none;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 8px;
      padding: 8px;
      font-family: inherit;
    }
    #homeSend,
    #chatSend {
      border: none;
      border-radius: 8px;
      padding: 0 16px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #homeSend:hover,
    #chatSend:hover {
      background: var(--vscode-button-hoverBackground);
    }
    #chatScreen {
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      max-width: 92%;
      padding: 10px 12px;
      border-radius: 10px;
      white-space: pre-wrap;
      line-height: 1.4;
      font-size: 13px;
    }
    .user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .assistant {
      align-self: flex-start;
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .error {
      align-self: center;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
  </style>
</head>
<body>
  <div id="root">
    <section id="homeScreen">
      <div id="homeHeader">
        <div id="homeTitle">Sidekick Sessions</div>
        <button id="configure" class="toolbarButton">Configure</button>
      </div>
      <div id="homeSessionList"></div>
      <div id="homeComposer">
        <textarea id="homeInput" placeholder="Start a new chat..."></textarea>
        <button id="homeSend">Chat</button>
      </div>
    </section>

    <section id="chatScreen" class="hidden">
      <div id="chatHeader">
        <button id="backHome" class="toolbarButton">Back</button>
        <div id="chatTitle">Conversation</div>
        <button id="newSession" class="toolbarButton">New</button>
      </div>
      <div id="messages"></div>
      <div id="chatComposer">
        <textarea id="chatInput" placeholder="Ask anything about code..."></textarea>
        <button id="chatSend">Send</button>
      </div>
    </section>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const homeScreenEl = document.getElementById("homeScreen");
    const chatScreenEl = document.getElementById("chatScreen");
    const homeSessionListEl = document.getElementById("homeSessionList");
    const homeInputEl = document.getElementById("homeInput");
    const homeSendEl = document.getElementById("homeSend");
    const chatInputEl = document.getElementById("chatInput");
    const chatSendEl = document.getElementById("chatSend");
    const messagesEl = document.getElementById("messages");
    const chatTitleEl = document.getElementById("chatTitle");

    const configureEl = document.getElementById("configure");
    const backHomeEl = document.getElementById("backHome");
    const newSessionEl = document.getElementById("newSession");

    let sessions = [];
    let activeSessionId = "";
    let activeMessages = [];
    let activeTitle = "Conversation";
    const defaultHomePlaceholder = "Start a new chat...";
    const defaultChatPlaceholder = "Ask anything about code...";

    function updateInputPlaceholder(context) {
      if (!context) {
        homeInputEl.placeholder = defaultHomePlaceholder;
        chatInputEl.placeholder = defaultChatPlaceholder;
        return;
      }

      const lineRange =
        context.startLine === context.endLine
          ? "line " + context.startLine
          : "lines " + context.startLine + "-" + context.endLine;
      const shortPath = context.filePath.length > 42 ? "..." + context.filePath.slice(-39) : context.filePath;
      const contextHint = "Context: " + shortPath + " (" + lineRange + ")";
      homeInputEl.placeholder = defaultHomePlaceholder + " | " + contextHint;
      chatInputEl.placeholder = defaultChatPlaceholder + " | " + contextHint;
    }

    function renderHomeSessions() {
      homeSessionListEl.innerHTML = "";
      if (!sessions.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No history yet. Start chatting below.";
        homeSessionListEl.appendChild(empty);
        return;
      }

      for (const session of sessions) {
        const row = document.createElement("div");
        row.className = "sessionItem";

        const title = document.createElement("div");
        title.className = "sessionTitle";
        title.textContent = session.title || "New Chat";
        row.appendChild(title);

        const del = document.createElement("button");
        del.className = "deleteSession";
        del.textContent = "x";
        del.title = "Delete session";
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "deleteSession", sessionId: session.id });
        });
        row.appendChild(del);

        row.addEventListener("click", () => {
          vscode.postMessage({ type: "openSession", sessionId: session.id });
        });

        homeSessionListEl.appendChild(row);
      }
    }

    function renderMessages() {
      messagesEl.innerHTML = "";
      if (!activeMessages.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Send a message to begin.";
        messagesEl.appendChild(empty);
        return;
      }

      for (const message of activeMessages) {
        const item = document.createElement("div");
        item.className = "msg " + (message.role || "assistant");
        item.textContent = message.content || "";
        messagesEl.appendChild(item);
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showHome() {
      chatScreenEl.classList.add("hidden");
      homeScreenEl.classList.remove("hidden");
      renderHomeSessions();
      homeInputEl.focus();
    }

    function showChat() {
      homeScreenEl.classList.add("hidden");
      chatScreenEl.classList.remove("hidden");
      chatTitleEl.textContent = activeTitle || "Conversation";
      renderMessages();
      chatInputEl.focus();
    }

    function sendFromHome() {
      const text = homeInputEl.value.trim();
      if (!text) {
        return;
      }

      homeSendEl.disabled = true;
      vscode.postMessage({ type: "send", text, createSession: true });
      homeInputEl.value = "";
    }

    function sendFromChat() {
      const text = chatInputEl.value.trim();
      if (!text || !activeSessionId) {
        return;
      }

      chatSendEl.disabled = true;
      vscode.postMessage({ type: "send", text, sessionId: activeSessionId });
      chatInputEl.value = "";
    }

    homeSendEl.addEventListener("click", sendFromHome);
    chatSendEl.addEventListener("click", sendFromChat);
    homeInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendFromHome();
      }
    });
    chatInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendFromChat();
      }
    });

    configureEl.addEventListener("click", () => {
      vscode.postMessage({ type: "configure" });
    });
    backHomeEl.addEventListener("click", showHome);
    newSessionEl.addEventListener("click", () => {
      vscode.postMessage({ type: "newSession" });
    });

    window.addEventListener("message", (event) => {
      const data = event.data;

      if (data.type === "homeState") {
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
        homeSendEl.disabled = false;
        chatSendEl.disabled = false;
        renderHomeSessions();
      }

      if (data.type === "chatState") {
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
        activeSessionId = data.activeSessionId || "";
        activeMessages = Array.isArray(data.messages) ? data.messages : [];
        activeTitle = data.title || "Conversation";
        homeSendEl.disabled = false;
        chatSendEl.disabled = false;
        showChat();
        renderHomeSessions();
      }

      if (data.type === "editorContext") {
        updateInputPlaceholder(data.context || null);
      }

      if (data.type === "assistantStart") {
        const item = document.createElement("div");
        item.className = "msg assistant";
        item.textContent = "";
        messagesEl.appendChild(item);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        window.__sidekickActiveAssistantEl = item;
      }

      if (data.type === "assistantDelta" && window.__sidekickActiveAssistantEl) {
        window.__sidekickActiveAssistantEl.textContent += data.text || "";
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      if (data.type === "assistantDone") {
        window.__sidekickActiveAssistantEl = null;
      }

      if (data.type === "error") {
        if (window.__sidekickActiveAssistantEl && !window.__sidekickActiveAssistantEl.textContent) {
          window.__sidekickActiveAssistantEl.remove();
        }
        window.__sidekickActiveAssistantEl = null;

        if (!chatScreenEl.classList.contains("hidden")) {
          const error = document.createElement("div");
          error.className = "msg error";
          error.textContent = data.text || "Unknown error";
          messagesEl.appendChild(error);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        homeSendEl.disabled = false;
        chatSendEl.disabled = false;
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
