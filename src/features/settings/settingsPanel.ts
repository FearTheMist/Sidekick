import * as vscode from "vscode";
import { SidekickConfig } from "../../core/config";
import { ModelEndpointType, ProviderConfig } from "../../core/llm";

export async function openSettingsPanel(): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "sidekickProviderSettings",
    "Sidekick Model Providers",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const nonce = String(Date.now());
  panel.webview.html = getHtml(panel.webview, nonce);

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const payload = message as
      | { type: "load" }
      | { type: "save"; providers?: ProviderConfig[] };

    if (payload.type === "load") {
      panel.webview.postMessage({
        type: "state",
        providers: SidekickConfig.getProviderSettings(),
      });
      return;
    }

    if (payload.type === "save") {
      const providers = sanitizeProviders(payload.providers || []);
      const cfg = vscode.workspace.getConfiguration("sidekick");
      await cfg.update(
        "providers",
        providers,
        vscode.ConfigurationTarget.Workspace
      );
      vscode.window.showInformationMessage("Sidekick provider settings saved.");
      panel.webview.postMessage({ type: "state", providers });
    }
  });
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
  if (normalized === "OPENAI_RESPONSE" || normalized === "OPENAI_RESPONSES") {
    return "OPENAI_RESPONSE";
  }
  if (
    normalized === "OPENAI_COMPATIBLE" ||
    normalized === "OPENAI_COMPATIBLE_RESPONSE" ||
    normalized === "OPENAI_COMPATIBLE_RESPONSES"
  ) {
    return normalized as ModelEndpointType;
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
  if (
    normalized === "OPENAI_COMPATIBLE" ||
    normalized === "OPENAI_COMPATIBLE_RESPONSE" ||
    normalized === "OPENAI_COMPATIBLE_RESPONSES"
  ) {
    return "openai-compatible";
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

function getHtml(webview: vscode.Webview, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --panel: #111b31;
      --panel-2: #15233f;
      --stroke: #2a3d63;
      --text: #deebff;
      --muted: #9cb4d7;
      --active: rgba(82, 147, 219, 0.16);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: linear-gradient(145deg, #0a1323, #12213b);
      font-family: "Segoe UI", "Noto Sans", sans-serif;
    }
    .root {
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 12px;
      height: 100vh;
      padding: 12px;
    }
    .panel {
      border: 1px solid var(--stroke);
      border-radius: 10px;
      background: rgba(17, 28, 49, 0.88);
      overflow: hidden;
      min-height: 0;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--stroke);
      background: rgba(9, 16, 30, 0.8);
    }
    .providers { overflow: auto; height: calc(100% - 51px); }
    .provider-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid #22375b;
      cursor: pointer;
    }
    .provider-item.active { background: var(--active); }
    .toggle-btn {
      border: 1px solid #2e486f;
      border-radius: 999px;
      min-width: 58px;
      min-height: 28px;
      font-size: 12px;
      padding: 0 10px;
      color: var(--text);
      background: #172742;
      cursor: pointer;
    }
    .toggle-btn.off { border-color: #68445d; color: #f3adc4; }
    .content { padding: 12px; overflow: auto; height: calc(100% - 51px); }
    .field { margin-bottom: 12px; }
    .field label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 12px; }
    input, select, button {
      border: 1px solid var(--stroke);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      min-height: 34px;
      padding: 6px 10px;
      font: inherit;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #2a3d63; padding: 8px; text-align: left; }
    th { background: #13213a; color: #a9c0e3; }
    td input, td select { width: 100%; }
    .actions { display: flex; justify-content: space-between; gap: 8px; margin-top: 14px; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .danger { border-color: #7d3652; color: #f3adc4; }
    @media (max-width: 980px) {
      .root { grid-template-columns: 1fr; grid-template-rows: 250px 1fr; }
    }
  </style>
</head>
<body>
  <div class="root">
    <section class="panel">
      <div class="header">
        <strong>Providers</strong>
        <button id="addProvider">+ Add</button>
      </div>
      <div id="providerList" class="providers"></div>
    </section>

    <section class="panel">
      <div class="header">
        <strong>Provider Config</strong>
        <button id="save">Save</button>
      </div>
      <div class="content">
        <div class="field">
          <label>Provider Name</label>
          <input id="providerName" placeholder="OpenAI" />
        </div>

        <div class="field">
          <label>API Base URL</label>
          <input id="baseUrl" placeholder="https://api.openai.com/v1" />
        </div>

        <div class="field">
          <label>API Key</label>
          <input id="apiKey" type="password" />
        </div>

        <div class="field">
          <label>Models</label>
          <table>
            <thead>
              <tr>
                <th style="width: 30%;">Model ID</th>
                <th style="width: 30%;">Name</th>
                <th style="width: 24%;">Endpoint Type</th>
                <th style="width: 16%;">Action</th>
              </tr>
            </thead>
            <tbody id="modelRows"></tbody>
          </table>
          <div class="actions">
            <button id="addModel">+ Add Model</button>
            <button id="removeProvider" class="danger">Remove Provider</button>
          </div>
          <div class="hint">Endpoint Type: OPENAI, OPENAI_RESPONSE, OPENAI_COMPATIBLE, OPENAI_COMPATIBLE_RESPONSE, ANTHROPIC_MESSAGES.</div>
        </div>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const endpointOptions = [
      'OPENAI',
      'OPENAI_RESPONSE',
      'OPENAI_COMPATIBLE',
      'OPENAI_COMPATIBLE_RESPONSE',
      'ANTHROPIC_MESSAGES'
    ];

    let state = { providers: [], selectedIndex: -1 };

    const providerList = document.getElementById('providerList');
    const providerName = document.getElementById('providerName');
    const baseUrl = document.getElementById('baseUrl');
    const apiKey = document.getElementById('apiKey');
    const modelRows = document.getElementById('modelRows');

    function ensureSelection() {
      if (state.providers.length === 0) {
        state.selectedIndex = -1;
        return;
      }
      if (state.selectedIndex < 0 || state.selectedIndex >= state.providers.length) {
        state.selectedIndex = 0;
      }
    }

    function selectedProvider() {
      ensureSelection();
      if (state.selectedIndex < 0) return undefined;
      return state.providers[state.selectedIndex];
    }

    function renderProviders() {
      ensureSelection();
      providerList.innerHTML = '';
      state.providers.forEach((provider, index) => {
        const row = document.createElement('div');
        row.className = 'provider-item' + (index === state.selectedIndex ? ' active' : '');
        row.onclick = () => {
          syncFormToState();
          state.selectedIndex = index;
          render();
        };

        const left = document.createElement('div');
        left.innerHTML = '<strong>' + escapeHtml(provider.label || provider.id || '(unnamed)') + '</strong><br/><span style="color:#9cb4d7;font-size:12px;">' + escapeHtml(provider.baseUrl || '') + '</span>';

        const toggle = document.createElement('button');
        const isOn = provider.enabled !== false;
        toggle.className = 'toggle-btn ' + (isOn ? 'on' : 'off');
        toggle.textContent = isOn ? 'ON' : 'OFF';
        toggle.onclick = (event) => {
          event.stopPropagation();
          provider.enabled = !isOn;
          renderProviders();
        };

        row.appendChild(left);
        row.appendChild(toggle);
        providerList.appendChild(row);
      });
    }

    function renderForm() {
      const provider = selectedProvider();
      if (!provider) {
        providerName.value = '';
        baseUrl.value = '';
        apiKey.value = '';
        modelRows.innerHTML = '';
        return;
      }

      providerName.value = provider.label || provider.id || '';
      baseUrl.value = provider.baseUrl || '';
      apiKey.value = provider.apiKey || '';

      modelRows.innerHTML = '';
      provider.models = Array.isArray(provider.models) ? provider.models : [];
      provider.models.forEach((model, index) => {
        const tr = document.createElement('tr');

        const tdId = document.createElement('td');
        const idInput = document.createElement('input');
        idInput.value = model.id || '';
        idInput.oninput = () => { model.id = idInput.value; };
        tdId.appendChild(idInput);

        const tdName = document.createElement('td');
        const nameInput = document.createElement('input');
        nameInput.value = model.name || '';
        nameInput.oninput = () => { model.name = nameInput.value; };
        tdName.appendChild(nameInput);

        const tdType = document.createElement('td');
        const typeSelect = document.createElement('select');
        endpointOptions.forEach((item) => {
          const option = document.createElement('option');
          option.value = item;
          option.textContent = item;
          if ((model.endpointType || 'OPENAI') === item) {
            option.selected = true;
          }
          typeSelect.appendChild(option);
        });
        typeSelect.onchange = () => { model.endpointType = typeSelect.value; };
        tdType.appendChild(typeSelect);

        const tdAction = document.createElement('td');
        const removeBtn = document.createElement('button');
        removeBtn.className = 'danger';
        removeBtn.textContent = 'Remove';
        removeBtn.onclick = () => {
          provider.models.splice(index, 1);
          renderForm();
        };
        tdAction.appendChild(removeBtn);

        tr.appendChild(tdId);
        tr.appendChild(tdName);
        tr.appendChild(tdType);
        tr.appendChild(tdAction);
        modelRows.appendChild(tr);
      });
    }

    function syncFormToState() {
      const provider = selectedProvider();
      if (!provider) return;
      const name = providerName.value.trim();
      provider.label = name;
      provider.id = toProviderId(name || provider.id || 'provider');
      provider.baseUrl = baseUrl.value.trim();
      provider.apiKey = apiKey.value;
      provider.models = Array.isArray(provider.models) ? provider.models : [];
      provider.defaultModel = provider.models[0]?.id || '';
      provider.apiType = 'openai-chat';
    }

    function toProviderId(name) {
      return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'provider';
    }

    function render() {
      renderProviders();
      renderForm();
    }

    function escapeHtml(text) {
      return String(text || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    }

    document.getElementById('addProvider').onclick = () => {
      syncFormToState();
      const index = state.providers.length + 1;
      state.providers.push({
        id: 'provider-' + index,
        label: 'Provider ' + index,
        apiType: 'openai-chat',
        baseUrl: '',
        apiKey: '',
        defaultModel: '',
        enabled: true,
        models: []
      });
      state.selectedIndex = state.providers.length - 1;
      render();
    };

    document.getElementById('removeProvider').onclick = () => {
      if (state.selectedIndex < 0) return;
      state.providers.splice(state.selectedIndex, 1);
      state.selectedIndex = Math.min(state.selectedIndex, state.providers.length - 1);
      render();
    };

    document.getElementById('addModel').onclick = () => {
      syncFormToState();
      const provider = selectedProvider();
      if (!provider) return;
      provider.models = Array.isArray(provider.models) ? provider.models : [];
      provider.models.push({ id: '', name: '', endpointType: 'OPENAI' });
      renderForm();
    };

    document.getElementById('save').onclick = () => {
      syncFormToState();
      vscode.postMessage({ type: 'save', providers: state.providers });
    };

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type !== 'state') return;
      state.providers = Array.isArray(msg.providers) ? msg.providers : [];
      if (state.providers.length > 0 && state.selectedIndex < 0) {
        state.selectedIndex = 0;
      }
      render();
    });

    vscode.postMessage({ type: 'load' });
  </script>
</body>
</html>`;
}
