import * as vscode from "vscode";
import { McpServerConfig } from "../../core/config";
import { McpManager, McpServerState } from "../../mcp/mcpManager";

type IncomingMessage =
  | { type: "ready" }
  | { type: "add"; server: unknown }
  | { type: "update"; name: string; server: unknown }
  | { type: "remove"; name: string }
  | { type: "connect"; name: string }
  | { type: "disconnect"; name: string }
  | { type: "refresh-tools"; name: string };

let currentPanel: vscode.WebviewPanel | undefined;

export async function openMcpPanel(
  _extensionUri: vscode.Uri,
  manager: McpManager
): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "sidekickMcpManager",
    "Sidekick MCP Manager",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  currentPanel = panel;

  const nonce = String(Date.now());
  panel.webview.html = getHtml(panel.webview, nonce);

  const postState = () => {
    panel.webview.postMessage({
      type: "state",
      servers: manager.listStates(),
    });
  };

  const stateSubscription = manager.onDidChangeState(() => {
    postState();
  });

  panel.onDidDispose(() => {
    currentPanel = undefined;
    stateSubscription.dispose();
  });

  panel.webview.onDidReceiveMessage(async (message: IncomingMessage) => {
    try {
      switch (message.type) {
        case "ready":
          postState();
          return;
        case "add":
          await manager.addServer(normalizeServerInput(message.server));
          vscode.window.showInformationMessage("MCP server added.");
          return;
        case "update":
          await manager.updateServer(message.name, normalizeServerInput(message.server));
          vscode.window.showInformationMessage("MCP server updated.");
          return;
        case "remove":
          await manager.removeServer(message.name);
          vscode.window.showInformationMessage("MCP server deleted.");
          return;
        case "connect": {
          const state = await manager.connect(message.name);
          if (state.status === "connected") {
            vscode.window.showInformationMessage(`Connected MCP server: ${message.name}`);
          } else if (state.error) {
            vscode.window.showErrorMessage(`Failed to connect ${message.name}: ${state.error}`);
          }
          return;
        }
        case "disconnect":
          await manager.disconnect(message.name);
          vscode.window.showInformationMessage(`Disconnected MCP server: ${message.name}`);
          return;
        case "refresh-tools":
          await manager.refreshTools(message.name);
          vscode.window.showInformationMessage(`Refreshed tools for ${message.name}`);
          return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      panel.webview.postMessage({ type: "error", message: detail });
      vscode.window.showErrorMessage(detail);
    }
  });
}

function normalizeServerInput(input: unknown): McpServerConfig {
  const value = (input && typeof input === "object" ? input : {}) as {
    name?: unknown;
    url?: unknown;
    headers?: unknown;
    timeout?: unknown;
    enabled?: unknown;
  };
  const headers = parseHeaders(value.headers);
  const timeout = Number(value.timeout);

  return {
    name: String(value.name || "").trim(),
    url: String(value.url || "").trim(),
    headers,
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : undefined,
    enabled: value.enabled !== false,
  };
}

function parseHeaders(input: unknown): Record<string, string> | undefined {
  if (!input) {
    return undefined;
  }

  const value = typeof input === "string" ? JSON.parse(input || "{}") : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Headers must be a JSON object.");
  }

  const headers = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [String(key), String(item)])
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function getHtml(webview: vscode.Webview, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #12161b;
      --panel-2: #171c22;
      --stroke: rgba(255,255,255,0.08);
      --text: #f5f7fa;
      --muted: #9ba6b2;
      --green: #35c58a;
      --red: #ff6c78;
      --yellow: #f2b84b;
      --blue: #5da9ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 Inter, "Segoe UI", sans-serif;
    }
    .root {
      display: grid;
      grid-template-columns: 320px 1fr;
      height: 100vh;
    }
    .sidebar, .content {
      min-height: 0;
      overflow: auto;
    }
    .sidebar {
      border-right: 1px solid var(--stroke);
      background: #0f1317;
    }
    .content {
      background: linear-gradient(180deg, rgba(255,255,255,0.02), transparent 160px), var(--bg);
    }
    .section {
      padding: 16px;
    }
    .toolbar, .row, .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar { justify-content: space-between; margin-bottom: 12px; }
    button {
      border: 1px solid var(--stroke);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button.primary { background: rgba(93,169,255,0.16); border-color: rgba(93,169,255,0.45); }
    button.danger { background: rgba(255,108,120,0.12); border-color: rgba(255,108,120,0.35); }
    button:disabled { opacity: 0.45; cursor: default; }
    .server-list {
      display: grid;
      gap: 10px;
    }
    .server {
      border: 1px solid var(--stroke);
      background: var(--panel);
      border-radius: 14px;
      padding: 12px;
      cursor: pointer;
    }
    .server.active { border-color: rgba(93,169,255,0.55); box-shadow: inset 0 0 0 1px rgba(93,169,255,0.3); }
    .server-title { display:flex; justify-content:space-between; gap:8px; }
    .name { font-weight: 600; }
    .url, .muted { color: var(--muted); }
    .url { margin-top: 6px; word-break: break-all; }
    .status { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .connected { color: var(--green); }
    .connecting { color: var(--yellow); }
    .failed { color: var(--red); }
    .disconnected { color: var(--muted); }
    .card {
      border: 1px solid var(--stroke);
      background: var(--panel);
      border-radius: 16px;
      padding: 16px;
      margin: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    label { display:grid; gap:6px; color: var(--muted); }
    input, textarea {
      width: 100%;
      border: 1px solid var(--stroke);
      border-radius: 10px;
      background: #0e1216;
      color: var(--text);
      padding: 10px 12px;
      font: inherit;
    }
    textarea { min-height: 120px; resize: vertical; }
    .span-2 { grid-column: span 2; }
    .tool {
      border-top: 1px solid var(--stroke);
      padding: 12px 0;
    }
    .tool:first-child { border-top: 0; padding-top: 0; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 8px 0 0;
      color: #c6d0db;
      background: #0d1116;
      border: 1px solid var(--stroke);
      border-radius: 10px;
      padding: 10px;
    }
    .empty { color: var(--muted); padding: 12px 0; }
    .error {
      margin: 0 16px 16px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,108,120,0.35);
      background: rgba(255,108,120,0.1);
      color: #ffd5d9;
      display: none;
    }
    @media (max-width: 900px) {
      .root { grid-template-columns: 1fr; }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--stroke); }
      .grid { grid-template-columns: 1fr; }
      .span-2 { grid-column: span 1; }
    }
  </style>
</head>
<body>
  <div class="root">
    <aside class="sidebar">
      <div class="section">
        <div class="toolbar">
          <strong>MCP Servers</strong>
          <button id="addBtn" class="primary">Add</button>
        </div>
        <div id="serverList" class="server-list"></div>
      </div>
    </aside>
    <main class="content">
      <div id="errorBox" class="error"></div>
      <section class="card">
        <div class="toolbar">
          <strong id="editorTitle">Server Details</strong>
          <span id="statusBadge" class="status disconnected">DISCONNECTED</span>
        </div>
        <div class="grid">
          <label>
            Name
            <input id="nameInput" type="text" />
          </label>
          <label>
            Timeout (ms)
            <input id="timeoutInput" type="number" min="1" step="1" />
          </label>
          <label class="span-2">
            URL
            <input id="urlInput" type="text" />
          </label>
          <label class="span-2">
            Headers JSON
            <textarea id="headersInput" spellcheck="false"></textarea>
          </label>
          <label class="row span-2">
            <input id="enabledInput" type="checkbox" style="width:auto;" />
            Enabled
          </label>
        </div>
        <div class="actions" style="margin-top:16px;">
          <button id="saveBtn" class="primary">Save</button>
          <button id="connectBtn">Connect</button>
          <button id="disconnectBtn">Disconnect</button>
          <button id="refreshBtn">Refresh Tools</button>
          <button id="deleteBtn" class="danger">Delete</button>
        </div>
        <div id="serverMeta" class="muted" style="margin-top:12px;"></div>
      </section>
      <section class="card">
        <div class="toolbar">
          <strong>Tools</strong>
          <span id="toolCount" class="muted">0 tools</span>
        </div>
        <div id="toolsList"></div>
      </section>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const blankDraft = () => ({ originalName: "", name: "", url: "", headers: "{}", timeout: "", enabled: true });
    let servers = [];
    let draft = blankDraft();

    const els = {
      serverList: document.getElementById("serverList"),
      errorBox: document.getElementById("errorBox"),
      editorTitle: document.getElementById("editorTitle"),
      statusBadge: document.getElementById("statusBadge"),
      nameInput: document.getElementById("nameInput"),
      urlInput: document.getElementById("urlInput"),
      headersInput: document.getElementById("headersInput"),
      timeoutInput: document.getElementById("timeoutInput"),
      enabledInput: document.getElementById("enabledInput"),
      saveBtn: document.getElementById("saveBtn"),
      connectBtn: document.getElementById("connectBtn"),
      disconnectBtn: document.getElementById("disconnectBtn"),
      refreshBtn: document.getElementById("refreshBtn"),
      deleteBtn: document.getElementById("deleteBtn"),
      serverMeta: document.getElementById("serverMeta"),
      toolsList: document.getElementById("toolsList"),
      toolCount: document.getElementById("toolCount"),
      addBtn: document.getElementById("addBtn"),
    };

    function currentState() {
      if (!draft.originalName) return undefined;
      return servers.find((item) => item.config.name === draft.originalName);
    }

    function loadDraftFromState(state) {
      if (!state) {
        draft = blankDraft();
        return;
      }
      draft = {
        originalName: state.config.name,
        name: state.config.name,
        url: state.config.url,
        headers: JSON.stringify(state.config.headers || {}, null, 2),
        timeout: state.config.timeout ? String(state.config.timeout) : "",
        enabled: state.config.enabled !== false,
      };
    }

    function syncInputs() {
      els.nameInput.value = draft.name;
      els.urlInput.value = draft.url;
      els.headersInput.value = draft.headers;
      els.timeoutInput.value = draft.timeout;
      els.enabledInput.checked = draft.enabled;
    }

    function readInputs() {
      draft.name = els.nameInput.value;
      draft.url = els.urlInput.value;
      draft.headers = els.headersInput.value.trim() || "{}";
      draft.timeout = els.timeoutInput.value;
      draft.enabled = els.enabledInput.checked;
    }

    function renderList() {
      els.serverList.innerHTML = "";
      if (servers.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No MCP servers configured.";
        els.serverList.appendChild(empty);
        return;
      }

      for (const state of servers) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "server " + (draft.originalName === state.config.name ? "active" : "");
        item.innerHTML =
          '<div class="server-title">' +
          '<span class="name"></span>' +
          '<span class="status ' + state.status + '">' + state.status + '</span>' +
          '</div>' +
          '<div class="url"></div>' +
          '<div class="muted">' + state.tools.length + ' tools</div>';
        item.querySelector(".name").textContent = state.config.name;
        item.querySelector(".url").textContent = state.config.url;
        item.addEventListener("click", () => {
          hideError();
          loadDraftFromState(state);
          render();
        });
        els.serverList.appendChild(item);
      }
    }

    function renderTools(state) {
      els.toolsList.innerHTML = "";
      els.toolCount.textContent = String((state && state.tools ? state.tools.length : 0)) + " tools";

      if (!state) {
        els.toolsList.innerHTML = '<div class="empty">Select an MCP server to inspect its tools.</div>';
        return;
      }
      if (state.tools.length === 0) {
        els.toolsList.innerHTML = '<div class="empty">' + (state.status === "connected" ? "No tools exposed by this server." : "Connect the server to load its tools.") + '</div>';
        return;
      }

      for (const tool of state.tools) {
        const item = document.createElement("div");
        item.className = "tool";
        const schema = JSON.stringify(tool.inputSchema || {}, null, 2);
        item.innerHTML =
          '<div class="row" style="justify-content:space-between;align-items:flex-start;">' +
          '<strong></strong>' +
          '</div>' +
          '<div class="muted"></div>' +
          '<pre></pre>';
        item.querySelector("strong").textContent = tool.name;
        item.querySelector(".muted").textContent = tool.description || "MCP tool";
        item.querySelector("pre").textContent = schema.length > 1200 ? schema.slice(0, 1200) + "..." : schema;
        els.toolsList.appendChild(item);
      }
    }

    function renderDetails(state) {
      els.editorTitle.textContent = draft.originalName ? "Server Details: " + draft.originalName : "New MCP Server";
      els.statusBadge.textContent = state ? state.status.toUpperCase() : "DRAFT";
      els.statusBadge.className = "status " + (state ? state.status : "disconnected");
      els.serverMeta.textContent = (state && state.error) || (state ? "Enabled: " + (state.config.enabled !== false ? "yes" : "no") : "Unsaved draft");

      const isConnected = state?.status === "connected";
      const isBusy = state?.status === "connecting";
      els.connectBtn.disabled = !draft.originalName || isConnected || isBusy;
      els.disconnectBtn.disabled = !draft.originalName || !isConnected;
      els.refreshBtn.disabled = !draft.originalName || !isConnected;
      els.deleteBtn.disabled = !draft.originalName || isConnected || isBusy;
      els.saveBtn.disabled = isConnected || isBusy;
    }

    function render() {
      syncInputs();
      renderList();
      const state = currentState();
      renderDetails(state);
      renderTools(state);
    }

    function showError(message) {
      els.errorBox.style.display = "block";
      els.errorBox.textContent = message;
    }

    function hideError() {
      els.errorBox.style.display = "none";
      els.errorBox.textContent = "";
    }

    els.addBtn.addEventListener("click", () => {
      hideError();
      draft = blankDraft();
      render();
    });

    els.saveBtn.addEventListener("click", () => {
      hideError();
      readInputs();
      const payload = {
        name: draft.name,
        url: draft.url,
        headers: draft.headers,
        timeout: draft.timeout,
        enabled: draft.enabled,
      };
      if (draft.originalName) {
        vscode.postMessage({ type: "update", name: draft.originalName, server: payload });
      } else {
        vscode.postMessage({ type: "add", server: payload });
      }
    });

    els.connectBtn.addEventListener("click", () => {
      hideError();
      if (draft.originalName) {
        vscode.postMessage({ type: "connect", name: draft.originalName });
      }
    });

    els.disconnectBtn.addEventListener("click", () => {
      hideError();
      if (draft.originalName) {
        vscode.postMessage({ type: "disconnect", name: draft.originalName });
      }
    });

    els.refreshBtn.addEventListener("click", () => {
      hideError();
      if (draft.originalName) {
        vscode.postMessage({ type: "refresh-tools", name: draft.originalName });
      }
    });

    els.deleteBtn.addEventListener("click", () => {
      hideError();
      if (draft.originalName) {
        vscode.postMessage({ type: "remove", name: draft.originalName });
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "state") {
        servers = message.servers || [];
        if (draft.originalName) {
          const next = servers.find((item) => item.config.name === draft.originalName);
          if (next) {
            loadDraftFromState(next);
          } else {
            draft = blankDraft();
          }
        } else if (servers.length > 0 && !draft.name && !draft.url) {
          loadDraftFromState(servers[0]);
        }
        render();
      }
      if (message.type === "error") {
        showError(message.message || "Unknown error");
      }
    });

    render();
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
