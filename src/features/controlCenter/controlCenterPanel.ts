import * as vscode from "vscode";
import {
  CommitMessageLanguage,
  McpServerConfig,
  PermissionPolicyConfig,
  SidekickConfig,
} from "../../core/config";
import { ModelEndpointType, ProviderConfig } from "../../core/llm";
import { McpManager } from "../../mcp/mcpManager";

export type ControlCenterSection =
  | "providers"
  | "mcp"
  | "permissions"
  | "general";

type IncomingMessage =
  | { type: "ready" }
  | { type: "navigate"; section?: ControlCenterSection }
  | {
      type: "save-providers";
      providers?: ProviderConfig[];
      commitMessageLanguage?: CommitMessageLanguage;
    }
  | { type: "save-permissions"; policy?: Partial<PermissionPolicyConfig> }
  | { type: "restore-permissions" }
  | { type: "clear-session-permissions" }
  | { type: "save-general"; commitMessageLanguage?: CommitMessageLanguage }
  | { type: "add-mcp"; server?: unknown }
  | { type: "update-mcp"; name?: string; server?: unknown }
  | { type: "remove-mcp"; name?: string }
  | { type: "connect-mcp"; name?: string }
  | { type: "disconnect-mcp"; name?: string }
  | { type: "refresh-mcp-tools"; name?: string };

let currentPanel: vscode.WebviewPanel | undefined;
let currentSection: ControlCenterSection = "providers";

export async function openControlCenterPanel(
  section: ControlCenterSection,
  manager: McpManager,
  clearSessionPermissions: () => void
): Promise<void> {
  currentSection = section;
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    await currentPanel.webview.postMessage({ type: "navigate", section });
    await postState(currentPanel, manager, section);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "sidekickControlCenter",
    "Sidekick Control Center",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  currentPanel = panel;

  const nonce = String(Date.now());
  panel.webview.html = getHtml(panel.webview, nonce);

  const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("sidekick.providers") ||
      event.affectsConfiguration("sidekick.commitMessageLanguage") ||
      event.affectsConfiguration("sidekick.mcpServers") ||
      event.affectsConfiguration("sidekick.permissions")
    ) {
      void postState(panel, manager, currentSection);
    }
  });
  const mcpSubscription = manager.onDidChangeState(() => {
    void postState(panel, manager, currentSection);
  });

  panel.onDidDispose(() => {
    currentPanel = undefined;
    configSubscription.dispose();
    mcpSubscription.dispose();
  });

  panel.webview.onDidReceiveMessage(async (message: IncomingMessage) => {
    try {
      switch (message.type) {
        case "ready":
          await postState(panel, manager, currentSection);
          return;
        case "navigate":
          currentSection = normalizeSection(message.section);
          await postState(panel, manager, currentSection);
          return;
        case "save-providers": {
          const cfg = vscode.workspace.getConfiguration("sidekick");
          await cfg.update(
            "providers",
            sanitizeProviders(message.providers || []),
            vscode.ConfigurationTarget.Global
          );
          await cfg.update(
            "commitMessageLanguage",
            sanitizeCommitMessageLanguage(message.commitMessageLanguage),
            vscode.ConfigurationTarget.Global
          );
          await postState(panel, manager, "providers", "saved");
          return;
        }
        case "save-permissions":
          await SidekickConfig.savePermissionPolicy(message.policy || {});
          await postState(panel, manager, "permissions", "saved");
          return;
        case "restore-permissions":
          await SidekickConfig.savePermissionPolicy(
            SidekickConfig.getDefaultPermissionPolicy()
          );
          await postState(panel, manager, "permissions", "saved");
          return;
        case "clear-session-permissions":
          clearSessionPermissions();
          vscode.window.showInformationMessage(
            "Sidekick session permissions cleared."
          );
          await panel.webview.postMessage({
            type: "toast",
            message: "Session permissions cleared",
          });
          return;
        case "save-general": {
          const cfg = vscode.workspace.getConfiguration("sidekick");
          await cfg.update(
            "commitMessageLanguage",
            sanitizeCommitMessageLanguage(message.commitMessageLanguage),
            vscode.ConfigurationTarget.Global
          );
          await postState(panel, manager, "general", "saved");
          return;
        }
        case "add-mcp":
          await manager.addServer(normalizeServerInput(message.server));
          vscode.window.showInformationMessage("MCP server added.");
          await postState(panel, manager, "mcp", "saved");
          return;
        case "update-mcp":
          await manager.updateServer(
            String(message.name || ""),
            normalizeServerInput(message.server)
          );
          vscode.window.showInformationMessage("MCP server updated.");
          await postState(panel, manager, "mcp", "saved");
          return;
        case "remove-mcp":
          await manager.removeServer(String(message.name || ""));
          vscode.window.showInformationMessage("MCP server deleted.");
          await postState(panel, manager, "mcp", "saved");
          return;
        case "connect-mcp":
          await manager.connect(String(message.name || ""));
          await postState(panel, manager, "mcp", "saved");
          return;
        case "disconnect-mcp":
          await manager.disconnect(String(message.name || ""));
          await postState(panel, manager, "mcp", "saved");
          return;
        case "refresh-mcp-tools":
          await manager.refreshTools(String(message.name || ""));
          await postState(panel, manager, "mcp", "saved");
          return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      panel.webview.postMessage({ type: "toast", message: detail, tone: "error" });
      vscode.window.showErrorMessage(detail);
    }
  });
}

async function postState(
  panel: vscode.WebviewPanel,
  manager: McpManager,
  section: ControlCenterSection,
  type: "state" | "saved" = "state"
): Promise<void> {
  await panel.webview.postMessage({
    type,
    section,
    providers: SidekickConfig.getProviderSettings(),
    commitMessageLanguage: SidekickConfig.getCommitMessageLanguage(),
    permissions: SidekickConfig.getPermissionPolicy(),
    permissionDefaults: SidekickConfig.getDefaultPermissionPolicy(),
    permissionEntries: getPermissionEntries(),
    mcpServers: manager.listStates(),
  });
}

function normalizeSection(value: unknown): ControlCenterSection {
  return value === "mcp" || value === "permissions" || value === "general"
    ? value
    : "providers";
}

function sanitizeCommitMessageLanguage(value: unknown): CommitMessageLanguage {
  if (value === "zh-CN" || value === "en") {
    return value;
  }
  return "auto";
}

function sanitizeProviders(input: ProviderConfig[]): ProviderConfig[] {
  return input
    .map((provider, index) => {
      const providerName = (provider.label || provider.id || "").trim();
      const label = providerName || `Provider ${index + 1}`;
      const id = toProviderId(label);
      const baseUrl = String(provider.baseUrl || "").trim();

      const models = (provider.models || [])
        .map((model) => {
          const modelId = String(model.id || "").trim();
          if (!modelId) {
            return undefined;
          }
          return {
            id: modelId,
            name: String(model.name || modelId).trim() || modelId,
            endpointType: normalizeEndpointType(model.endpointType),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      return {
        id,
        label,
        apiType: endpointTypeToApiType(models[0]?.endpointType),
        baseUrl,
        apiKey: String(provider.apiKey || ""),
        defaultModel: models[0]?.id || "",
        enabled: provider.enabled !== false,
        compatibleMode: provider.compatibleMode,
        headers: provider.headers,
        body: provider.body,
        models,
      } satisfies ProviderConfig;
    })
    .filter((provider) => provider.baseUrl.length > 0);
}

function normalizeEndpointType(type: unknown): ModelEndpointType {
  const normalized = String(type || "OPENAI").trim().toUpperCase();
  if (normalized === "OPENAI" || normalized === "OPENAI_CHAT") {
    return "OPENAI";
  }
  if (
    normalized === "OPENAI_RESPONSE" ||
    normalized === "OPENAI_RESPONSES" ||
    normalized === "OPENAI_COMPATIBLE_RESPONSE" ||
    normalized === "OPENAI_COMPATIBLE_RESPONSES"
  ) {
    return "OPENAI_RESPONSE";
  }
  if (normalized === "OPENAI_COMPATIBLE") {
    return "OPENAI";
  }
  if (normalized === "ANTHROPIC" || normalized === "ANTHROPIC_MESSAGES") {
    return "ANTHROPIC_MESSAGES";
  }
  return "OPENAI";
}

function endpointTypeToApiType(
  endpointType: ModelEndpointType | undefined
): ProviderConfig["apiType"] {
  const normalized = normalizeEndpointType(endpointType);
  if (normalized === "OPENAI") {
    return "openai-chat";
  }
  if (normalized === "OPENAI_RESPONSE") {
    return "openai-responses";
  }
  return "anthropic-messages";
}

function toProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
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

function getPermissionEntries(): Array<{
  key: keyof PermissionPolicyConfig;
  title: string;
  description: string;
  examples: string[];
}> {
  return [
    {
      key: "terminal_read",
      title: "Read Project State",
      description: "Reads project state without modifying files or system state.",
      examples: ["git status", "git diff", "ls"],
    },
    {
      key: "terminal_project_exec",
      title: "Run Project Validation",
      description: "Runs project verification tasks such as tests, builds, or linting.",
      examples: ["npm test", "pnpm build", "cargo test"],
    },
    {
      key: "terminal_project_mutation",
      title: "Modify Project State",
      description: "Changes project dependencies, git state, or other project data.",
      examples: ["npm install", "git add", "git commit"],
    },
    {
      key: "terminal_external_access",
      title: "Access Outside Workspace",
      description: "Reads or writes files outside the current workspace folder.",
      examples: ["Get-Content C:/Windows/win.ini", "Copy-Item ../secrets.txt ./tmp"],
    },
    {
      key: "terminal_network",
      title: "Network Access",
      description: "Allows terminal commands to access remote network resources.",
      examples: ["curl https://example.com", "wget https://example.com/file"],
    },
    {
      key: "terminal_destructive",
      title: "High-Risk Commands",
      description:
        "Allows commands that may delete files, overwrite data, or start nested shells.",
      examples: ["rm -rf dist", "Remove-Item .\\build -Recurse", "powershell -Command ..."],
    },
  ];
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
      --bg: #0a0d11;
      --panel: rgba(16, 20, 26, 0.94);
      --panel-2: rgba(22, 27, 34, 0.98);
      --panel-3: rgba(34, 41, 50, 0.96);
      --stroke: rgba(255,255,255,0.08);
      --muted: #96a4b4;
      --text: #f5f7fb;
      --blue: #69b6ff;
      --blue-soft: rgba(105,182,255,0.16);
      --red-soft: rgba(255,107,120,0.14);
      --yellow-soft: rgba(255,202,112,0.12);
      --green-soft: rgba(72,210,159,0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(780px 260px at 15% -10%, rgba(105,182,255,0.14), transparent 55%),
        radial-gradient(900px 340px at 100% 0%, rgba(140,109,255,0.12), transparent 48%),
        var(--bg);
      font: 13px/1.5 Inter, "Segoe UI", sans-serif;
    }
    .shell {
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .nav {
      border-bottom: 1px solid var(--stroke);
      background: rgba(10, 13, 17, 0.9);
      padding: 14px 24px 12px;
      position: sticky;
      top: 0;
      z-index: 2;
      backdrop-filter: blur(10px);
    }
    .tabs {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .nav-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: 1px solid transparent;
      border-radius: 14px;
      background: transparent;
      color: var(--text);
      text-align: left;
      padding: 12px 14px;
      cursor: pointer;
    }
    .nav-btn.active {
      border-color: rgba(105,182,255,0.4);
      background: linear-gradient(180deg, rgba(105,182,255,0.14), rgba(105,182,255,0.05));
    }
    .main {
      min-width: 0;
      overflow: auto;
      padding: 24px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 20px;
    }
    .hero-note {
      color: var(--muted);
      min-width: 0;
    }
    .status {
      border: 1px solid var(--stroke);
      border-radius: 999px;
      padding: 8px 12px;
      color: var(--muted);
      background: rgba(255,255,255,0.03);
      white-space: nowrap;
    }
    .section { display: none; }
    .section.active { display: block; }
    .grid { display: grid; gap: 16px; }
    .split { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; }
    .card {
      border: 1px solid var(--stroke);
      border-radius: 18px;
      background: var(--panel);
      padding: 16px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.18);
    }
    .card h3 { margin: 0 0 8px; font-size: 16px; }
    .card p { margin: 0; color: var(--muted); }
    .toolbar, .row, .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .toolbar { margin-bottom: 14px; }
    button, input, select, textarea {
      border: 1px solid var(--stroke);
      border-radius: 12px;
      background: var(--panel-2);
      color: var(--text);
      padding: 9px 12px;
      font: inherit;
    }
    textarea { width: 100%; min-height: 120px; resize: vertical; }
    button { cursor: pointer; }
    button.primary { border-color: rgba(105,182,255,0.4); background: linear-gradient(180deg, rgba(105,182,255,0.18), rgba(105,182,255,0.07)); }
    button.danger { background: var(--red-soft); }
    .list { display: grid; gap: 10px; max-height: 70vh; overflow: auto; }
    .list-item {
      border: 1px solid var(--stroke);
      border-radius: 16px;
      padding: 14px;
      background: rgba(255,255,255,0.02);
      cursor: pointer;
    }
    .list-item.active { border-color: rgba(105,182,255,0.45); background: rgba(105,182,255,0.08); }
    .list-item .title { font-weight: 600; }
    .list-item .sub { color: var(--muted); margin-top: 4px; word-break: break-all; }
    .list-item .badge { font-size: 12px; color: var(--muted); margin-top: 8px; }
    .context-menu {
      position: fixed;
      min-width: 136px;
      padding: 6px;
      border: 1px solid var(--stroke);
      border-radius: 12px;
      background: rgba(16, 20, 26, 0.98);
      box-shadow: 0 16px 40px rgba(0,0,0,0.28);
      z-index: 20;
    }
    .context-menu.hidden { display: none; }
    .context-menu button {
      width: 100%;
      min-height: 34px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      text-align: left;
      box-shadow: none;
    }
    .context-menu button:hover {
      background: rgba(255,255,255,0.06);
    }
    .context-menu button.danger {
      color: #ff9aa5;
    }
    .context-menu button.danger:hover {
      background: rgba(255,107,120,0.14);
    }
    .field { display: grid; gap: 6px; margin-bottom: 14px; }
    .field label { color: var(--muted); font-size: 12px; }
    .field-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      min-width: 28px;
      min-height: 28px;
      padding: 0;
    }
    .icon-btn svg {
      width: 18px;
      height: 18px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .toggle-field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid var(--stroke);
      border-radius: 14px;
      background: rgba(255,255,255,0.02);
      margin-bottom: 14px;
    }
    .toggle-copy strong {
      display: block;
      font-size: 13px;
      font-weight: 600;
    }
    .toggle-copy span {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .toggle-btn {
      position: relative;
      width: 52px;
      height: 30px;
      border-radius: 999px;
      border: 1px solid var(--stroke);
      background: rgba(255,255,255,0.06);
      padding: 0;
      flex: 0 0 auto;
    }
    .toggle-btn::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #f5f7fb;
      transition: transform 140ms ease;
    }
    .toggle-btn.on {
      background: linear-gradient(180deg, rgba(105,182,255,0.32), rgba(105,182,255,0.18));
      border-color: rgba(105,182,255,0.45);
    }
    .toggle-btn.on::after {
      transform: translateX(22px);
    }
    .triple { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .double { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .table th, .table td { border: 1px solid var(--stroke); padding: 8px; }
    .table th { color: var(--muted); font-weight: 600; background: rgba(255,255,255,0.03); }
    .muted { color: var(--muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .chip {
      border: 1px solid var(--stroke);
      border-radius: 999px;
      padding: 4px 10px;
      font: 12px/1.4 Consolas, "Courier New", monospace;
      background: rgba(255,255,255,0.03);
    }
    .warn { border-color: rgba(255,202,112,0.26); background: var(--yellow-soft); }
    .safe { border-color: rgba(72,210,159,0.24); background: var(--green-soft); }
    .tool-list { margin-top: 12px; display: grid; gap: 8px; }
    .tool { border: 1px solid var(--stroke); border-radius: 12px; padding: 10px 12px; background: rgba(255,255,255,0.02); }
    .tool strong { display: block; }
    .section-note { margin-bottom: 14px; color: var(--muted); }
    .pill { border-radius: 999px; padding: 3px 8px; font-size: 12px; border: 1px solid var(--stroke); }
    @media (max-width: 980px) {
      .split, .triple, .double { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="nav">
      <div class="tabs">
        <button class="nav-btn" data-section="providers">Providers <span class="pill">Models</span></button>
        <button class="nav-btn" data-section="mcp">MCP <span class="pill">Tools</span></button>
        <button class="nav-btn" data-section="permissions">Permissions <span class="pill">Policy</span></button>
        <button class="nav-btn" data-section="general">General <span class="pill">App</span></button>
      </div>
    </header>
    <main class="main">
      <div class="hero">
        <div id="heroNote" class="hero-note"></div>
        <div id="status" class="status">Loading...</div>
      </div>

      <section id="section-providers" class="section">
        <div class="split">
          <div class="card">
            <div class="toolbar">
              <h3 style="margin:0">Providers</h3>
              <button id="addProvider">Add</button>
            </div>
            <div id="providerList" class="list"></div>
          </div>
          <div class="card">
            <div class="toolbar">
              <h3 id="providerEditorTitle" style="margin:0">Provider</h3>
            </div>
            <div id="providerEmpty" class="muted">Select a provider to edit it, or add a new one.</div>
            <div id="providerEditor" style="display:none;">
              <div class="triple">
                <div class="field"><label>Name</label><input id="providerName" /></div>
                <div class="field"><label>Base URL</label><input id="providerBaseUrl" /></div>
                <div class="field"><div class="field-head"><label>API Key</label><button id="toggleProviderApiKey" class="icon-btn" type="button" aria-label="Show API key" title="Show API key"></button></div><input id="providerApiKey" type="password" /></div>
              </div>
              <div class="toggle-field"><div class="toggle-copy"><strong>Enabled</strong><span>Include this provider in Sidekick model selection.</span></div><button id="providerEnabled" class="toggle-btn" type="button" aria-label="Toggle provider enabled"></button></div>
              <div class="field">
                <label>Models</label>
                <table class="table">
                  <thead><tr><th>Model ID</th><th>Name</th><th>Endpoint Type</th><th>Action</th></tr></thead>
                  <tbody id="providerModels"></tbody>
                </table>
                <div class="actions"><button id="addProviderModel">Add Model</button></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="section-mcp" class="section">
        <div class="grid">
          <div class="double">
            <div class="card"><h3>Connected Servers</h3><p id="mcpConnectedCount">0</p></div>
            <div class="card"><h3>Total Tools</h3><p id="mcpToolCount">0</p></div>
          </div>
          <div class="split">
            <div class="card">
              <div class="toolbar">
                <h3 style="margin:0">Servers</h3>
                <button id="addMcp">Add</button>
              </div>
              <div id="mcpList" class="list"></div>
            </div>
            <div class="card">
              <div class="toolbar">
                <h3 id="mcpEditorTitle" style="margin:0">Server</h3>
              </div>
              <div id="mcpEmpty" class="muted">Select a server to inspect or edit it, or add a new server.</div>
              <div id="mcpEditor" style="display:none;">
                <div class="double">
                  <div class="field"><label>Name</label><input id="mcpName" /></div>
                  <div class="field"><label>URL</label><input id="mcpUrl" /></div>
                </div>
                <div class="double">
                  <div class="toggle-field"><div class="toggle-copy"><strong>Enabled</strong><span>Keep this MCP server available in Sidekick.</span></div><button id="mcpEnabled" class="toggle-btn" type="button" aria-label="Toggle MCP enabled"></button></div>
                  <div class="field"><label>Timeout (ms)</label><input id="mcpTimeout" type="number" min="0" /></div>
                </div>
                <div class="field"><label>Headers (JSON object)</label><textarea id="mcpHeaders"></textarea></div>
                <div class="actions">
                  <button id="connectMcp">Connect</button>
                  <button id="disconnectMcp">Disconnect</button>
                  <button id="refreshMcpTools">Refresh Tools</button>
                </div>
                <div id="mcpMeta" class="section-note"></div>
                <div id="mcpTools" class="tool-list"></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="section-permissions" class="section">
        <div class="toolbar">
          <button id="restorePermissions">Restore Defaults</button>
          <button id="clearSessionPermissions">Clear Session Permissions</button>
        </div>
        <div id="permissionGrid" class="grid"></div>
      </section>

      <section id="section-general" class="section">
        <div class="card" style="max-width:640px;">
          <h3>Commit Message Language</h3>
          <p>Controls the language used when Sidekick generates commit messages.</p>
          <div class="field" style="margin-top:14px;"><label>Language</label><select id="generalCommitLanguage"><option value="auto">Auto</option><option value="zh-CN">中文</option><option value="en">English</option></select></div>
        </div>
      </section>
    </main>
  </div>
  <div id="providerContextMenu" class="context-menu hidden">
    <button id="duplicateProviderAction" type="button">Duplicate Provider</button>
    <button id="deleteProviderAction" class="danger" type="button">Delete Provider</button>
  </div>
  <div id="mcpContextMenu" class="context-menu hidden">
    <button id="duplicateMcpAction" type="button">Duplicate Server</button>
    <button id="deleteMcpAction" class="danger" type="button">Delete Server</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const endpointOptions = ['OPENAI','OPENAI_RESPONSE','ANTHROPIC_MESSAGES'];
    const state = {
      section: 'providers',
      providers: [],
      selectedProvider: -1,
      providerDraft: null,
      commitMessageLanguage: 'auto',
      mcpServers: [],
      selectedMcp: -1,
      mcpDraft: null,
      mcpEditingName: '',
      permissions: {},
      permissionEntries: []
    };

    const statusEl = document.getElementById('status');
    const heroNoteEl = document.getElementById('heroNote');
    const toggleProviderApiKeyBtn = document.getElementById('toggleProviderApiKey');
    const providerContextMenu = document.getElementById('providerContextMenu');
    const mcpContextMenu = document.getElementById('mcpContextMenu');
    const sectionNotes = {
      providers: 'Configure your chat and agent providers, manage model lists, and set commit message language.',
      mcp: 'Manage MCP servers, inspect connection status, and refresh exposed tools.',
      permissions: 'Choose default behavior for each terminal permission class. Session approvals are temporary and can be cleared here.',
      general: 'Configure general Sidekick behavior that applies across chat, agents, and tool usage.'
    };

    function setStatus(message) { statusEl.textContent = message; }
    function saveProvidersNow() {
      setStatus('Saving...');
      vscode.postMessage({ type: 'save-providers', providers: state.providers, commitMessageLanguage: state.commitMessageLanguage });
    }
    function saveMcpNow() {
      if (state.selectedMcp === -2) {
        if (!commitMcpDraftIfReady()) {
          setStatus('Unsaved draft');
        }
        return;
      }
      const server = state.mcpServers[state.selectedMcp];
      if (!server || server.status === 'connected' || server.status === 'connecting') return;
      const payload = currentMcpPayload();
      if (!String(payload.name || '').trim() || !String(payload.url || '').trim()) {
        setStatus('Unsaved draft');
        return;
      }
      setStatus('Saving...');
      vscode.postMessage({ type: 'update-mcp', name: state.mcpEditingName || server.config.name, server: payload });
      state.mcpEditingName = payload.name;
    }
    function commitProviderDraftIfReady() {
      if (state.selectedProvider !== -2 || !state.providerDraft) {
        return false;
      }
      if (!String(state.providerDraft.baseUrl || '').trim()) {
        return false;
      }
      state.providers.push(state.providerDraft);
      state.selectedProvider = state.providers.length - 1;
      state.providerDraft = null;
      renderProviders();
      saveProvidersNow();
      return true;
    }
    function commitMcpDraftIfReady() {
      if (state.selectedMcp !== -2 || !state.mcpDraft) {
        return false;
      }
      if (!String(state.mcpDraft.name || '').trim() || !String(state.mcpDraft.url || '').trim()) {
        return false;
      }
      setStatus('Saving...');
      vscode.postMessage({ type: 'add-mcp', server: state.mcpDraft });
      state.mcpEditingName = state.mcpDraft.name;
      state.mcpDraft = null;
      state.selectedMcp = state.mcpServers.length;
      return true;
    }
    function hideProviderContextMenu() {
      providerContextMenu.classList.add('hidden');
    }
    function hideMcpContextMenu() {
      mcpContextMenu.classList.add('hidden');
    }
    function hideContextMenus() {
      hideProviderContextMenu();
      hideMcpContextMenu();
    }
    function openProviderContextMenu(x, y, index) {
      state.selectedProvider = index;
      renderProviders();
      providerContextMenu.dataset.index = String(index);
      providerContextMenu.style.left = x + 'px';
      providerContextMenu.style.top = y + 'px';
      providerContextMenu.classList.remove('hidden');
    }
    function openMcpContextMenu(x, y, index) {
      state.selectedMcp = index;
      state.mcpEditingName = state.mcpServers[index]?.config?.name || '';
      renderMcp();
      mcpContextMenu.dataset.index = String(index);
      mcpContextMenu.style.left = x + 'px';
      mcpContextMenu.style.top = y + 'px';
      mcpContextMenu.classList.remove('hidden');
    }
    function uniqueMcpName(base) {
      const clean = String(base || 'new-server').trim() || 'new-server';
      const names = new Set(state.mcpServers.map((server) => server.config.name));
      if (!names.has(clean)) return clean;
      let index = 2;
      while (names.has(clean + '-' + index)) index += 1;
      return clean + '-' + index;
    }
    function renderApiKeyToggle() {
      const isHidden = document.getElementById('providerApiKey').type === 'password';
      toggleProviderApiKeyBtn.setAttribute('aria-label', isHidden ? 'Show API key' : 'Hide API key');
      toggleProviderApiKeyBtn.setAttribute('title', isHidden ? 'Show API key' : 'Hide API key');
      toggleProviderApiKeyBtn.innerHTML = isHidden
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 10.7a3 3 0 0 0 4.2 4.2"></path><path d="M9.4 5.3A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.2 17.2 0 0 1-5 5.3"></path><path d="M6.7 6.7C3.8 8.4 2 12 2 12a17.8 17.8 0 0 0 7.3 6"></path></svg>';
    }
    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    function ensureSelection() {
      if (state.selectedProvider === -2 && state.providerDraft) return;
      if (state.providers.length === 0) state.selectedProvider = -1;
      else if (state.selectedProvider < 0 || state.selectedProvider >= state.providers.length) state.selectedProvider = 0;
      if (state.selectedMcp === -2 && state.mcpDraft) return;
      if (state.mcpServers.length === 0) state.selectedMcp = -1;
      else if (state.selectedMcp < 0 || state.selectedMcp >= state.mcpServers.length) state.selectedMcp = 0;
    }
    function navigate(section) {
      state.section = section;
      heroNoteEl.textContent = sectionNotes[section] || '';
      document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.section === section);
      });
      document.querySelectorAll('.section').forEach((el) => {
        el.classList.toggle('active', el.id === 'section-' + section);
      });
    }

    function renderProviders() {
      const list = document.getElementById('providerList');
      const items = state.providers.map((provider, index) => {
        const active = index === state.selectedProvider ? ' active' : '';
        const models = Array.isArray(provider.models) ? provider.models.length : 0;
        return '<div class="list-item' + active + '" data-provider-index="' + index + '">' +
          '<div class="title">' + escapeHtml(provider.label || provider.id || ('Provider ' + (index + 1))) + '</div>' +
          '<div class="sub">' + escapeHtml(provider.baseUrl || '') + '</div>' +
          '<div class="badge">' + (provider.enabled === false ? 'Disabled' : 'Enabled') + ' · ' + models + ' models</div>' +
          '</div>';
      });
      if (state.providerDraft) {
        items.push('<div class="list-item' + (state.selectedProvider === -2 ? ' active' : '') + '" data-provider-draft="true">' +
          '<div class="title">' + escapeHtml(state.providerDraft.label || 'New Provider') + '</div>' +
          '<div class="sub">' + escapeHtml(state.providerDraft.baseUrl || 'Unsaved draft') + '</div>' +
          '<div class="badge">draft · ' + String((state.providerDraft.models || []).length) + ' models</div>' +
          '</div>');
      }
      list.innerHTML = items.join('');
      list.querySelectorAll('[data-provider-index]').forEach((el) => {
        el.addEventListener('click', () => {
          state.selectedProvider = Number(el.dataset.providerIndex);
          hideProviderContextMenu();
          renderProviders();
        });
        el.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          openProviderContextMenu(event.clientX, event.clientY, Number(el.dataset.providerIndex));
        });
      });
      list.querySelectorAll('[data-provider-draft]').forEach((el) => {
        el.addEventListener('click', () => {
          state.selectedProvider = -2;
          hideProviderContextMenu();
          renderProviders();
        });
      });

      const empty = document.getElementById('providerEmpty');
      const editor = document.getElementById('providerEditor');
      const provider = state.selectedProvider === -2 ? undefined : state.providers[state.selectedProvider];
      const draft = state.selectedProvider === -2 ? state.providerDraft : null;
      if (!provider && !draft) {
        empty.style.display = 'block';
        editor.style.display = 'none';
        return;
      }
      empty.style.display = 'none';
      editor.style.display = 'block';
      const current = draft || provider;
      document.getElementById('providerEditorTitle').textContent = draft ? 'New Provider' : (provider.label || provider.id || 'Provider');
      document.getElementById('providerName').value = current.label || '';
      document.getElementById('providerBaseUrl').value = current.baseUrl || '';
      document.getElementById('providerApiKey').value = current.apiKey || '';
      document.getElementById('providerEnabled').dataset.value = current.enabled === false ? 'false' : 'true';
      document.getElementById('providerEnabled').classList.toggle('on', current.enabled !== false);
      renderApiKeyToggle();
      renderProviderModels();
    }

    function renderProviderModels() {
      const tbody = document.getElementById('providerModels');
      const provider = state.selectedProvider === -2 ? state.providerDraft : state.providers[state.selectedProvider];
      if (!provider) { tbody.innerHTML = ''; return; }
      const models = Array.isArray(provider.models) ? provider.models : [];
      tbody.innerHTML = models.map((model, index) => '<tr>' +
        '<td><input data-model-id="' + index + '" value="' + escapeHtml(model.id || '') + '" /></td>' +
        '<td><input data-model-name="' + index + '" value="' + escapeHtml(model.name || '') + '" /></td>' +
        '<td><select data-model-endpoint="' + index + '">' + endpointOptions.map((option) => '<option value="' + option + '"' + (option === model.endpointType ? ' selected' : '') + '>' + option + '</option>').join('') + '</select></td>' +
        '<td><button data-model-remove="' + index + '">Remove</button></td>' +
        '</tr>').join('');
      tbody.querySelectorAll('[data-model-id]').forEach((el) => {
        el.addEventListener('input', (event) => {
          provider.models[event.target.dataset.modelId].id = event.target.value;
          setStatus('Unsaved draft');
        });
        el.addEventListener('change', (event) => {
          provider.models[event.target.dataset.modelId].id = event.target.value;
          if (!String(event.target.value || '').trim() || state.selectedProvider === -2) {
            setStatus('Unsaved draft');
            return;
          }
          saveProvidersNow();
        });
      });
      tbody.querySelectorAll('[data-model-name]').forEach((el) => {
        el.addEventListener('input', (event) => {
          provider.models[event.target.dataset.modelName].name = event.target.value;
          setStatus('Unsaved draft');
        });
        el.addEventListener('change', (event) => {
          provider.models[event.target.dataset.modelName].name = event.target.value;
          if (!String(provider.models[event.target.dataset.modelName].id || '').trim() || state.selectedProvider === -2) {
            setStatus('Unsaved draft');
            return;
          }
          saveProvidersNow();
        });
      });
      tbody.querySelectorAll('[data-model-endpoint]').forEach((el) => el.addEventListener('change', (event) => {
        provider.models[event.target.dataset.modelEndpoint].endpointType = event.target.value;
        if (!String(provider.models[event.target.dataset.modelEndpoint].id || '').trim()) {
          setStatus('Unsaved draft');
          return;
        }
        if (state.selectedProvider === -2) {
          setStatus('Unsaved draft');
          return;
        }
        saveProvidersNow();
      }));
      tbody.querySelectorAll('[data-model-remove]').forEach((el) => el.addEventListener('click', () => {
        provider.models.splice(Number(el.dataset.modelRemove), 1);
        renderProviderModels();
        if (state.selectedProvider === -2) {
          setStatus('Unsaved draft');
          return;
        }
        saveProvidersNow();
      }));
    }

    function syncProviderDraft() {
      const provider = state.selectedProvider === -2 ? state.providerDraft : state.providers[state.selectedProvider];
      if (!provider) return;
      provider.label = document.getElementById('providerName').value;
      provider.baseUrl = document.getElementById('providerBaseUrl').value;
      provider.apiKey = document.getElementById('providerApiKey').value;
      provider.enabled = document.getElementById('providerEnabled').dataset.value !== 'false';
    }

    function renderMcp() {
      document.getElementById('mcpConnectedCount').textContent = String(state.mcpServers.filter((item) => item.status === 'connected').length);
      document.getElementById('mcpToolCount').textContent = String(state.mcpServers.reduce((sum, item) => sum + (Array.isArray(item.tools) ? item.tools.length : 0), 0));
      const list = document.getElementById('mcpList');
      const items = state.mcpServers.map((server, index) => {
        const active = index === state.selectedMcp ? ' active' : '';
        return '<div class="list-item' + active + '" data-mcp-index="' + index + '">' +
          '<div class="title">' + escapeHtml(server.config.name) + '</div>' +
          '<div class="sub">' + escapeHtml(server.config.url) + '</div>' +
          '<div class="badge">' + escapeHtml(server.status) + ' · ' + String((server.tools || []).length) + ' tools</div>' +
          '</div>';
      });
      if (state.mcpDraft) {
        items.push('<div class="list-item' + (state.selectedMcp === -2 ? ' active' : '') + '" data-mcp-draft="true">' +
          '<div class="title">' + escapeHtml(state.mcpDraft.name || 'New MCP Server') + '</div>' +
          '<div class="sub">' + escapeHtml(state.mcpDraft.url || 'Unsaved draft') + '</div>' +
          '<div class="badge">draft · not connected</div>' +
          '</div>');
      }
      list.innerHTML = items.join('');
      list.querySelectorAll('[data-mcp-index]').forEach((el) => {
        el.addEventListener('click', () => {
          state.selectedMcp = Number(el.dataset.mcpIndex);
          state.mcpEditingName = state.mcpServers[state.selectedMcp]?.config?.name || '';
          hideMcpContextMenu();
          renderMcp();
        });
        el.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          openMcpContextMenu(event.clientX, event.clientY, Number(el.dataset.mcpIndex));
        });
      });
      list.querySelectorAll('[data-mcp-draft]').forEach((el) => el.addEventListener('click', () => {
        state.selectedMcp = -2;
        hideMcpContextMenu();
        renderMcp();
      }));
      const server = state.selectedMcp === -2 ? undefined : state.mcpServers[state.selectedMcp];
      const draft = state.selectedMcp === -2 ? state.mcpDraft : null;
      const empty = document.getElementById('mcpEmpty');
      const editor = document.getElementById('mcpEditor');
      if (!server && !draft) {
        empty.style.display = 'block';
        editor.style.display = 'none';
        return;
      }
      empty.style.display = 'none';
      editor.style.display = 'block';
      const config = draft || server.config;
      document.getElementById('mcpEditorTitle').textContent = draft ? 'New MCP Server' : server.config.name;
      document.getElementById('mcpName').value = config.name || '';
      document.getElementById('mcpUrl').value = config.url || '';
      document.getElementById('mcpEnabled').dataset.value = config.enabled === false ? 'false' : 'true';
      document.getElementById('mcpEnabled').classList.toggle('on', config.enabled !== false);
      document.getElementById('mcpTimeout').value = config.timeout || '';
      document.getElementById('mcpHeaders').value = config.headers ? JSON.stringify(config.headers, null, 2) : '';
      document.getElementById('mcpMeta').textContent = draft
        ? 'Status: draft · save to create this server'
        : 'Status: ' + server.status + (server.error ? ' · ' + server.error : '');
      document.getElementById('connectMcp').disabled = !server || server.status === 'connected' || server.status === 'connecting';
      document.getElementById('disconnectMcp').disabled = !server || server.status !== 'connected';
      document.getElementById('refreshMcpTools').disabled = !server || server.status !== 'connected';
      document.getElementById('mcpTools').innerHTML = draft
        ? '<div class="muted">Save this draft to create the server, then connect to load tools.</div>'
        : (server.tools || []).map((tool) => '<div class="tool"><strong>' + escapeHtml(tool.name) + '</strong><span class="muted">' + escapeHtml(tool.description || '') + '</span></div>').join('') || '<div class="muted">No tools loaded.</div>';
    }

    function currentMcpPayload() {
      return {
        name: document.getElementById('mcpName').value,
        url: document.getElementById('mcpUrl').value,
        enabled: document.getElementById('mcpEnabled').dataset.value !== 'false',
        timeout: document.getElementById('mcpTimeout').value,
        headers: document.getElementById('mcpHeaders').value,
      };
    }

    function syncMcpDraft() {
      if (state.selectedMcp !== -2 || !state.mcpDraft) return;
      Object.assign(state.mcpDraft, currentMcpPayload());
    }
    function syncMcpEditor() {
      if (state.selectedMcp === -2) {
        syncMcpDraft();
        return;
      }
      const server = state.mcpServers[state.selectedMcp];
      if (!server || server.status === 'connected' || server.status === 'connecting') return;
      Object.assign(server.config, currentMcpPayload());
    }

    function renderPermissions() {
      const grid = document.getElementById('permissionGrid');
      grid.innerHTML = state.permissionEntries.map((entry) => {
        const value = state.permissions[entry.key] || 'ask';
        return '<div class="card ' + (value === 'allow' ? 'safe' : value === 'deny' ? 'warn' : '') + '">' +
          '<div class="row" style="justify-content:space-between;align-items:flex-start;">' +
          '<div><h3>' + escapeHtml(entry.title) + '</h3><p>' + escapeHtml(entry.description) + '</p></div>' +
          '<select data-permission-key="' + entry.key + '">' +
          '<option value="allow"' + (value === 'allow' ? ' selected' : '') + '>Allow by Default</option>' +
          '<option value="ask"' + (value === 'ask' ? ' selected' : '') + '>Always Ask</option>' +
          '<option value="deny"' + (value === 'deny' ? ' selected' : '') + '>Deny by Default</option>' +
          '</select></div>' +
          '<div class="chips">' + entry.examples.map((item) => '<span class="chip">' + escapeHtml(item) + '</span>').join('') + '</div>' +
          '</div>';
      }).join('');
      grid.querySelectorAll('[data-permission-key]').forEach((el) => el.addEventListener('change', (event) => {
        state.permissions[event.target.dataset.permissionKey] = event.target.value;
        vscode.postMessage({ type: 'save-permissions', policy: state.permissions });
        setStatus('Saving...');
      }));
    }

    function renderGeneral() {
      document.getElementById('generalCommitLanguage').value = state.commitMessageLanguage || 'auto';
    }

    function renderAll() {
      ensureSelection();
      navigate(state.section);
      renderProviders();
      renderMcp();
      renderPermissions();
      renderGeneral();
    }

    document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => {
      const section = btn.dataset.section || 'providers';
      navigate(section);
      vscode.postMessage({ type: 'navigate', section });
    }));
    document.getElementById('addProvider').addEventListener('click', () => {
      state.providerDraft = { id: '', label: 'New Provider', apiType: 'openai-chat', baseUrl: '', apiKey: '', defaultModel: '', enabled: true, models: [{ id: '', name: '', endpointType: 'OPENAI' }] };
      state.selectedProvider = -2;
      hideContextMenus();
      renderProviders();
      setStatus('Draft created');
    });
    ['providerName','providerBaseUrl','providerApiKey'].forEach((id) => {
      document.getElementById(id).addEventListener('input', () => {
        syncProviderDraft();
        setStatus('Unsaved draft');
      });
      document.getElementById(id).addEventListener('change', () => {
        syncProviderDraft();
        if (state.selectedProvider === -2) {
          if (commitProviderDraftIfReady()) {
            return;
          }
          setStatus('Unsaved draft');
          return;
        }
        saveProvidersNow();
      });
    });
    document.getElementById('providerEnabled').addEventListener('click', () => {
      const el = document.getElementById('providerEnabled');
      const next = el.dataset.value === 'false' ? 'true' : 'false';
      el.dataset.value = next;
      el.classList.toggle('on', next !== 'false');
      syncProviderDraft();
      if (state.selectedProvider === -2) {
        if (commitProviderDraftIfReady()) {
          return;
        }
        setStatus('Unsaved draft');
        return;
      }
      saveProvidersNow();
    });
    toggleProviderApiKeyBtn.addEventListener('click', () => {
      const input = document.getElementById('providerApiKey');
      input.type = input.type === 'password' ? 'text' : 'password';
      renderApiKeyToggle();
    });
    document.getElementById('duplicateProviderAction').addEventListener('click', () => {
      const index = Number(providerContextMenu.dataset.index);
      const provider = state.providers[index];
      hideProviderContextMenu();
      if (!provider) return;
      const models = Array.isArray(provider.models)
        ? provider.models.map((model) => ({ ...model }))
        : [];
      state.providerDraft = {
        ...provider,
        id: '',
        label: (provider.label || 'Provider') + ' Copy',
        models,
      };
      state.providers.push(state.providerDraft);
      state.selectedProvider = state.providers.length - 1;
      state.providerDraft = null;
      renderProviders();
      saveProvidersNow();
    });
    document.getElementById('deleteProviderAction').addEventListener('click', () => {
      const index = Number(providerContextMenu.dataset.index);
      hideProviderContextMenu();
      if (!Number.isInteger(index) || index < 0) return;
      state.providers.splice(index, 1);
      if (state.selectedProvider >= state.providers.length) {
        state.selectedProvider = state.providers.length - 1;
      }
      renderProviders();
      saveProvidersNow();
    });
    document.addEventListener('click', (event) => {
      if (!providerContextMenu.contains(event.target)) hideProviderContextMenu();
      if (!mcpContextMenu.contains(event.target)) hideMcpContextMenu();
    });
    window.addEventListener('blur', hideContextMenus);
    window.addEventListener('scroll', hideContextMenus, true);
    document.getElementById('addProviderModel').addEventListener('click', () => {
      const provider = state.selectedProvider === -2 ? state.providerDraft : state.providers[state.selectedProvider];
      if (!provider) return;
      provider.models = Array.isArray(provider.models) ? provider.models : [];
      provider.models.push({ id: '', name: '', endpointType: 'OPENAI' });
      renderProviderModels();
      setStatus('Unsaved draft');
    });

    document.getElementById('addMcp').addEventListener('click', () => {
      state.mcpDraft = { name: uniqueMcpName('new-server'), url: '', enabled: true, timeout: '', headers: '' };
      state.selectedMcp = -2;
      state.mcpEditingName = '';
      hideContextMenus();
      renderMcp();
      setStatus('Draft created');
    });
    document.getElementById('duplicateMcpAction').addEventListener('click', () => {
      const index = Number(mcpContextMenu.dataset.index);
      const server = state.mcpServers[index];
      hideMcpContextMenu();
      if (!server) return;
      const config = server.config;
      const copy = {
        ...config,
        name: uniqueMcpName((config.name || 'server') + '-copy'),
        headers: config.headers ? { ...config.headers } : undefined,
      };
      state.selectedMcp = state.mcpServers.length;
      state.mcpEditingName = copy.name;
      setStatus('Saving...');
      vscode.postMessage({ type: 'add-mcp', server: copy });
    });
    document.getElementById('deleteMcpAction').addEventListener('click', () => {
      const index = Number(mcpContextMenu.dataset.index);
      const server = state.mcpServers[index];
      hideMcpContextMenu();
      if (!server) return;
      setStatus('Saving...');
      vscode.postMessage({ type: 'remove-mcp', name: server.config.name });
    });
    ['mcpName','mcpUrl','mcpTimeout','mcpHeaders'].forEach((id) => {
      document.getElementById(id).addEventListener('input', () => {
        syncMcpEditor();
        setStatus('Unsaved draft');
      });
      document.getElementById(id).addEventListener('change', () => {
        syncMcpEditor();
        saveMcpNow();
      });
    });
    document.getElementById('mcpEnabled').addEventListener('click', () => {
      const el = document.getElementById('mcpEnabled');
      const next = el.dataset.value === 'false' ? 'true' : 'false';
      el.dataset.value = next;
      el.classList.toggle('on', next !== 'false');
      syncMcpEditor();
      saveMcpNow();
    });
    document.getElementById('connectMcp').addEventListener('click', () => {
      const server = state.mcpServers[state.selectedMcp];
      if (!server) return;
      setStatus('Connecting...');
      vscode.postMessage({ type: 'connect-mcp', name: server.config.name });
    });
    document.getElementById('disconnectMcp').addEventListener('click', () => {
      const server = state.mcpServers[state.selectedMcp];
      if (!server) return;
      setStatus('Disconnecting...');
      vscode.postMessage({ type: 'disconnect-mcp', name: server.config.name });
    });
    document.getElementById('refreshMcpTools').addEventListener('click', () => {
      const server = state.mcpServers[state.selectedMcp];
      if (!server) return;
      setStatus('Refreshing tools...');
      vscode.postMessage({ type: 'refresh-mcp-tools', name: server.config.name });
    });
    document.getElementById('restorePermissions').addEventListener('click', () => {
      setStatus('Saving...');
      vscode.postMessage({ type: 'restore-permissions' });
    });
    document.getElementById('clearSessionPermissions').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear-session-permissions' });
    });
    document.getElementById('generalCommitLanguage').addEventListener('change', () => {
      state.commitMessageLanguage = document.getElementById('generalCommitLanguage').value;
      setStatus('Saving...');
      vscode.postMessage({ type: 'save-general', commitMessageLanguage: state.commitMessageLanguage });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state' || message.type === 'saved') {
        state.section = message.section || state.section;
        state.providers = Array.isArray(message.providers) ? message.providers : [];
        state.commitMessageLanguage = message.commitMessageLanguage || 'auto';
        state.mcpServers = Array.isArray(message.mcpServers) ? message.mcpServers : [];
        state.permissions = message.permissions || {};
        state.permissionEntries = Array.isArray(message.permissionEntries) ? message.permissionEntries : [];
        if (state.selectedProvider !== -2) {
          state.providerDraft = null;
        }
        if (state.selectedMcp !== -2) {
          state.mcpDraft = null;
        }
        renderAll();
        setStatus(message.type === 'saved' ? 'Saved' : 'Ready');
      }
      if (message.type === 'navigate') {
        state.section = message.section || state.section;
        navigate(state.section);
      }
      if (message.type === 'toast') {
        setStatus(message.message || 'Updated');
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
