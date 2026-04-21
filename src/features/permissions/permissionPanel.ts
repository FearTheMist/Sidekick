import * as vscode from "vscode";
import {
  PermissionPolicyAction,
  PermissionPolicyConfig,
  SidekickConfig,
} from "../../core/config";

type IncomingMessage =
  | { type: "load" }
  | { type: "save"; policy?: Partial<PermissionPolicyConfig> }
  | { type: "restore-defaults" }
  | { type: "clear-session" };

let currentPanel: vscode.WebviewPanel | undefined;

export async function openPermissionPanel(
  clearSessionPermissions: () => void
): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "sidekickPermissionSettings",
    "Sidekick Permissions",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );
  currentPanel = panel;

  const nonce = String(Date.now());
  panel.webview.html = getHtml(panel.webview, nonce);

  const postState = async (type: "state" | "saved" = "state") => {
    await panel.webview.postMessage({
      type,
      policy: SidekickConfig.getPermissionPolicy(),
      defaults: SidekickConfig.getDefaultPermissionPolicy(),
      entries: getPermissionEntries(),
    });
  };

  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (message: IncomingMessage) => {
    switch (message.type) {
      case "load":
        await postState();
        return;
      case "save":
        await SidekickConfig.savePermissionPolicy(message.policy || {});
        await postState("saved");
        return;
      case "restore-defaults":
        await SidekickConfig.savePermissionPolicy(
          SidekickConfig.getDefaultPermissionPolicy()
        );
        await postState("saved");
        return;
      case "clear-session":
        clearSessionPermissions();
        vscode.window.showInformationMessage(
          "Sidekick session permissions cleared."
        );
        return;
    }
  });
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
      --bg: #0b0d11;
      --panel: rgba(18, 22, 28, 0.92);
      --panel-2: rgba(24, 29, 37, 0.96);
      --stroke: rgba(255,255,255,0.09);
      --text: #f5f7fb;
      --muted: #9ca7b5;
      --blue: #68b5ff;
      --blue-soft: rgba(104,181,255,0.12);
      --ring: rgba(0,0,0,0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(700px 260px at 20% -5%, rgba(104,181,255,0.12), transparent 55%),
        radial-gradient(840px 340px at 100% 0%, rgba(115,92,255,0.1), transparent 45%),
        var(--bg);
      font: 13px/1.5 Inter, "Segoe UI", sans-serif;
    }
    .root {
      max-width: 1040px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 18px;
    }
    .title {
      font-size: 24px;
      font-weight: 700;
      margin: 0;
    }
    .subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      max-width: 720px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 18px;
    }
    button, select {
      border: 1px solid var(--stroke);
      border-radius: 12px;
      background: var(--panel-2);
      color: var(--text);
      padding: 9px 12px;
      font: inherit;
    }
    button {
      cursor: pointer;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0)), var(--panel-2);
    }
    button.primary {
      border-color: rgba(104,181,255,0.45);
      background: linear-gradient(180deg, rgba(104,181,255,0.2), rgba(104,181,255,0.08));
    }
    .status {
      color: var(--muted);
      margin-bottom: 16px;
      min-height: 20px;
    }
    .grid {
      display: grid;
      gap: 14px;
    }
    .card {
      border: 1px solid var(--stroke);
      border-radius: 18px;
      background: var(--panel);
      box-shadow: 0 10px 30px var(--ring);
      padding: 16px;
    }
    .card-top {
      display: flex;
      gap: 14px;
      justify-content: space-between;
      align-items: flex-start;
    }
    .card h3 {
      margin: 0;
      font-size: 15px;
    }
    .card p {
      margin: 8px 0 0;
      color: var(--muted);
    }
    .examples {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .example {
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 999px;
      background: rgba(255,255,255,0.03);
      padding: 5px 10px;
      color: #d9e1eb;
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
    }
    .hint {
      margin-top: 18px;
      border: 1px solid rgba(104,181,255,0.22);
      background: var(--blue-soft);
      border-radius: 16px;
      padding: 14px 16px;
      color: #dcecff;
    }
    .hint strong {
      display: block;
      margin-bottom: 6px;
    }
    @media (max-width: 760px) {
      .hero, .card-top {
        flex-direction: column;
      }
      select {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="root">
    <div class="hero">
      <div>
        <h1 class="title">Permission Settings</h1>
        <p class="subtitle">Choose how Sidekick handles terminal permission categories by default. Session approvals are temporary and can be cleared at any time.</p>
      </div>
    </div>
    <div class="toolbar">
      <button id="save" class="primary">Save Changes</button>
      <button id="restore">Restore Defaults</button>
      <button id="clear">Clear Session Permissions</button>
    </div>
    <div id="status" class="status"></div>
    <div id="grid" class="grid"></div>
    <div class="hint">
      <strong>Policy meanings</strong>
      <div><code>Allow by Default</code>: Sidekick runs matching commands without asking.</div>
      <div><code>Always Ask</code>: Sidekick shows a permission prompt before running matching commands.</div>
      <div><code>Deny by Default</code>: Sidekick blocks matching commands unless the classification changes.</div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const grid = document.getElementById('grid');
    const status = document.getElementById('status');
    const state = {
      entries: [],
      policy: {},
      defaults: {},
    };

    function optionLabel(value) {
      if (value === 'allow') return 'Allow by Default';
      if (value === 'deny') return 'Deny by Default';
      return 'Always Ask';
    }

    function render() {
      grid.innerHTML = '';
      state.entries.forEach((entry) => {
        const card = document.createElement('section');
        card.className = 'card';
        const examples = entry.examples
          .map((item) => '<span class="example">' + escapeHtml(item) + '</span>')
          .join('');
        card.innerHTML = [
          '<div class="card-top">',
          '  <div>',
          '    <h3>' + escapeHtml(entry.title) + '</h3>',
          '    <p>' + escapeHtml(entry.description) + '</p>',
          '  </div>',
          '  <label>',
          '    <select data-key="' + entry.key + '">',
          ['allow', 'ask', 'deny'].map((value) => {
            const selected = state.policy[entry.key] === value ? ' selected' : '';
            return '<option value="' + value + '"' + selected + '>' + optionLabel(value) + '</option>';
          }).join(''),
          '    </select>',
          '  </label>',
          '</div>',
          '<div class="examples">' + examples + '</div>'
        ].join('');
        grid.appendChild(card);
      });

      grid.querySelectorAll('select[data-key]').forEach((select) => {
        select.addEventListener('change', (event) => {
          const target = event.target;
          state.policy[target.dataset.key] = target.value;
          status.textContent = 'Unsaved changes';
        });
      });
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    document.getElementById('save').addEventListener('click', () => {
      vscode.postMessage({ type: 'save', policy: state.policy });
    });

    document.getElementById('restore').addEventListener('click', () => {
      vscode.postMessage({ type: 'restore-defaults' });
    });

    document.getElementById('clear').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear-session' });
      status.textContent = 'Session permissions cleared';
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state' || message.type === 'saved') {
        state.entries = Array.isArray(message.entries) ? message.entries : [];
        state.policy = message.policy || {};
        state.defaults = message.defaults || {};
        render();
        status.textContent = message.type === 'saved' ? 'Saved' : '';
      }
    });

    vscode.postMessage({ type: 'load' });
  </script>
</body>
</html>`;
}
