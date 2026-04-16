import * as vscode from "vscode";
import {
  CommitMessageLanguage,
  SidekickConfig,
} from "../../core/config";
import { ModelEndpointType, ProviderConfig } from "../../core/llm";

export async function openSettingsPanel(): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "sidekickProviderSettings",
    "Sidekick Settings",
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
      | {
          type: "save";
          providers?: ProviderConfig[];
          commitMessageLanguage?: CommitMessageLanguage;
        };

    if (payload.type === "load") {
      panel.webview.postMessage({
        type: "state",
        providers: SidekickConfig.getProviderSettings(),
        commitMessageLanguage: SidekickConfig.getCommitMessageLanguage(),
      });
      return;
    }

    if (payload.type === "save") {
      const providers = sanitizeProviders(payload.providers || []);
      const commitMessageLanguage = sanitizeCommitMessageLanguage(
        payload.commitMessageLanguage
      );
      const cfg = vscode.workspace.getConfiguration("sidekick");
      await cfg.update(
        "providers",
        providers,
        vscode.ConfigurationTarget.Global
      );
      await cfg.update(
        "commitMessageLanguage",
        commitMessageLanguage,
        vscode.ConfigurationTarget.Global
      );
      panel.webview.postMessage({
        type: "saved",
      });
    }
  });
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
      --bg: #07080a;
      --surface: #101111;
      --surface-2: #0d0e10;
      --surface-3: #1b1c1e;
      --stroke: rgba(255, 255, 255, 0.08);
      --stroke-strong: #252829;
      --text: #f9f9f9;
      --muted: #9c9c9d;
      --subtle: #6a6b6c;
      --blue: #55b3ff;
      --blue-soft: hsla(202, 100%, 67%, 0.15);
      --red: #ff6363;
      --red-soft: hsla(0, 100%, 69%, 0.15);
      --ring: rgb(27, 28, 30) 0px 0px 0px 1px, rgb(7, 8, 10) 0px 0px 0px 1px inset;
      --button-shadow: rgba(255, 255, 255, 0.05) 0px 1px 0px 0px inset, rgba(255, 255, 255, 0.14) 0px 0px 0px 1px, rgba(0, 0, 0, 0.2) 0px -1px 0px 0px inset;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(900px 400px at 50% -10%, rgba(215, 201, 175, 0.05), transparent 60%),
        radial-gradient(800px 300px at 110% 0%, rgba(85, 179, 255, 0.08), transparent 55%),
        var(--bg);
      font-family: Inter, "Segoe UI", "Noto Sans", sans-serif;
      font-feature-settings: "calt" 1, "kern" 1, "liga" 1, "ss03" 1;
      letter-spacing: 0.2px;
    }
    .root {
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 16px;
      height: 100vh;
      padding: 16px;
    }
    .panel {
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      background: rgba(16, 17, 17, 0.94);
      box-shadow: var(--ring);
      overflow: hidden;
      min-height: 0;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--stroke-strong);
      background: rgba(7, 8, 10, 0.88);
    }
    .header strong {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .header-status {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .providers { overflow: auto; height: calc(100% - 51px); }
    .provider-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      cursor: pointer;
      transition: opacity 140ms ease, background 140ms ease;
    }
    .provider-item:hover { opacity: 0.86; }
    .provider-main {
      min-width: 0;
      overflow: hidden;
    }
    .provider-name {
      display: block;
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .provider-url {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .provider-item.active {
      background: linear-gradient(180deg, rgba(85, 179, 255, 0.14), rgba(85, 179, 255, 0.08));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }
    .toggle-btn {
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      min-width: 58px;
      min-height: 28px;
      font-size: 12px;
      padding: 0 10px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.04);
      box-shadow: var(--button-shadow);
      cursor: pointer;
      justify-self: end;
    }
    .toggle-btn.off {
      border-color: rgba(255, 99, 99, 0.2);
      color: #ffb3b3;
      background: var(--red-soft);
    }
    .content { padding: 16px; overflow: auto; height: calc(100% - 51px); }
    .hidden { display: none !important; }
    .content.empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
    }
    .empty-state {
      max-width: 320px;
      text-align: center;
      line-height: 1.6;
      font-size: 13px;
    }
    .triple-row { display: grid; grid-template-columns: 1fr 1.4fr 1.2fr; gap: 10px; }
    .field { margin-bottom: 16px; }
    .field label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 12px; font-weight: 500; }
    .secret-input {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .secret-input input {
      min-width: 0;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      min-width: 38px;
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
    input, select, button {
      border: 1px solid var(--stroke);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--text);
      min-height: 38px;
      padding: 8px 12px;
      font: inherit;
      letter-spacing: inherit;
    }
    input::placeholder { color: var(--subtle); }
    input:focus, select:focus, button:focus {
      outline: none;
      border-color: rgba(85, 179, 255, 0.45);
      box-shadow: 0 0 0 4px var(--blue-soft);
    }
    button {
      box-shadow: var(--button-shadow);
      transition: opacity 140ms ease;
    }
    button:hover { opacity: 0.78; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; border: 1px solid var(--stroke-strong); border-radius: 12px; overflow: hidden; }
    th, td { border: 1px solid var(--stroke-strong); padding: 10px; text-align: left; }
    th { background: rgba(255, 255, 255, 0.03); color: var(--muted); font-size: 12px; font-weight: 600; }
    td input, td select { width: 100%; }
    .actions { display: flex; justify-content: space-between; gap: 8px; margin-top: 16px; }
    .hint { color: var(--muted); font-size: 12px; margin-top: 8px; line-height: 1.5; }
    .danger {
      border-color: rgba(255, 99, 99, 0.22);
      color: #ffc3c3;
      background: var(--red-soft);
    }
    .context-menu {
      position: fixed;
      min-width: 160px;
      padding: 6px;
      border: 1px solid var(--stroke-strong);
      border-radius: 10px;
      background: rgba(16, 17, 17, 0.98);
      box-shadow: var(--ring);
      z-index: 1000;
    }
    .context-menu.hidden { display: none; }
    .context-menu button {
      width: 100%;
      min-height: 34px;
      text-align: left;
      border: 0;
      background: transparent;
      box-shadow: none;
    }
    .context-menu button:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.06);
    }
    @media (max-width: 980px) {
      .root { grid-template-columns: 1fr; grid-template-rows: 250px 1fr; }
      .triple-row { grid-template-columns: 1fr; }
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
        <strong id="configTitle"></strong>
        <span id="saveStatus" class="header-status">Auto-saved</span>
      </div>
      <div id="configContent" class="content">
        <div id="configEmptyState" class="empty-state hidden">Select a provider to edit its configuration, or add a new provider to get started.</div>
        <div id="configFormBody">
        <div class="triple-row">
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
            <div class="secret-input">
              <input id="apiKey" type="password" />
              <button id="toggleApiKey" class="icon-btn" type="button" aria-label="Show API key" title="Show API key"></button>
            </div>
          </div>
        </div>

        <div class="field">
          <label>Commit Message Language</label>
          <select id="commitMessageLanguage">
            <option value="auto">Auto</option>
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
          <div class="hint">Auto follows recent commit history when clear, otherwise infers from the diff.</div>
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
          </div>
          <div class="hint">Endpoint Type: OPENAI, OPENAI_RESPONSE, OPENAI_COMPATIBLE, OPENAI_COMPATIBLE_RESPONSE, ANTHROPIC_MESSAGES.</div>
        </div>
        </div>
      </div>
    </section>
  </div>

  <div id="providerContextMenu" class="context-menu hidden">
    <button id="deleteProviderAction" class="danger" type="button">Delete Provider</button>
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

    let state = { providers: [], selectedIndex: -1, commitMessageLanguage: 'auto' };
    let saveTimer = undefined;

    const providerList = document.getElementById('providerList');
    const providerName = document.getElementById('providerName');
    const baseUrl = document.getElementById('baseUrl');
    const apiKey = document.getElementById('apiKey');
    const configTitle = document.getElementById('configTitle');
    const saveStatus = document.getElementById('saveStatus');
    const configContent = document.getElementById('configContent');
    const configEmptyState = document.getElementById('configEmptyState');
    const configFormBody = document.getElementById('configFormBody');
    const commitMessageLanguage = document.getElementById('commitMessageLanguage');
    const toggleApiKey = document.getElementById('toggleApiKey');
    const modelRows = document.getElementById('modelRows');
    const providerContextMenu = document.getElementById('providerContextMenu');
    const deleteProviderAction = document.getElementById('deleteProviderAction');
    const visibleApiKeyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const hiddenApiKeyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 10.7a3 3 0 0 0 4 4"></path><path d="M9.4 5.5A11.4 11.4 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-4 4.8"></path><path d="M6.7 6.7A18.2 18.2 0 0 0 2 12s3.6 7 10 7a10.7 10.7 0 0 0 5.3-1.4"></path></svg>';
    let isApiKeyVisible = false;
    let contextMenuIndex = -1;

    function setSaveStatus(text) {
      saveStatus.textContent = text;
    }

    function setApiKeyVisibility(visible) {
      isApiKeyVisible = visible;
      apiKey.type = visible ? 'text' : 'password';
      toggleApiKey.innerHTML = visible ? visibleApiKeyIcon : hiddenApiKeyIcon;
      toggleApiKey.setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
      toggleApiKey.setAttribute('title', visible ? 'Hide API key' : 'Show API key');
    }

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
        row.oncontextmenu = (event) => {
          event.preventDefault();
          syncFormToState();
          state.selectedIndex = index;
          render();
          showContextMenu(event.clientX, event.clientY, index);
        };

        const left = document.createElement('div');
        left.className = 'provider-main';

        const nameEl = document.createElement('span');
        nameEl.className = 'provider-name';
        nameEl.textContent = provider.label || provider.id || '(unnamed)';

        const urlEl = document.createElement('span');
        urlEl.className = 'provider-url';
        urlEl.textContent = provider.baseUrl || '';

        left.appendChild(nameEl);
        left.appendChild(urlEl);

        const toggle = document.createElement('button');
        const isOn = provider.enabled !== false;
        toggle.className = 'toggle-btn ' + (isOn ? 'on' : 'off');
        toggle.textContent = isOn ? 'ON' : 'OFF';
        toggle.onclick = (event) => {
          event.stopPropagation();
          provider.enabled = !isOn;
          renderProviders();
          scheduleSave();
        };

        row.appendChild(left);
        row.appendChild(toggle);
        providerList.appendChild(row);
      });
    }

    function renderForm() {
      commitMessageLanguage.value = state.commitMessageLanguage || 'auto';

      const provider = selectedProvider();
      if (!provider) {
        configTitle.textContent = '';
        configContent.classList.add('empty');
        configFormBody.classList.add('hidden');
        configEmptyState.classList.remove('hidden');
        providerName.value = '';
        baseUrl.value = '';
        apiKey.value = '';
        setApiKeyVisibility(false);
        modelRows.innerHTML = '';
        return;
      }

      configTitle.textContent = 'Provider Config';
      configContent.classList.remove('empty');
      configFormBody.classList.remove('hidden');
      configEmptyState.classList.add('hidden');

      providerName.value = provider.label || provider.id || '';
      baseUrl.value = provider.baseUrl || '';
      apiKey.value = provider.apiKey || '';
      setApiKeyVisibility(false);

      modelRows.innerHTML = '';
      provider.models = Array.isArray(provider.models) ? provider.models : [];
      provider.models.forEach((model, index) => {
        const tr = document.createElement('tr');

        const tdId = document.createElement('td');
        const idInput = document.createElement('input');
        idInput.value = model.id || '';
        idInput.oninput = () => {
          model.id = idInput.value;
          scheduleSave();
        };
        tdId.appendChild(idInput);

        const tdName = document.createElement('td');
        const nameInput = document.createElement('input');
        nameInput.value = model.name || '';
        nameInput.oninput = () => {
          model.name = nameInput.value;
          scheduleSave();
        };
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
        typeSelect.onchange = () => {
          model.endpointType = typeSelect.value;
          scheduleSave();
        };
        tdType.appendChild(typeSelect);

        const tdAction = document.createElement('td');
        const removeBtn = document.createElement('button');
        removeBtn.className = 'danger';
        removeBtn.textContent = 'Remove';
        removeBtn.onclick = () => {
          provider.models.splice(index, 1);
          renderForm();
          scheduleSave();
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
      if (!providerName || !baseUrl || !apiKey || !commitMessageLanguage) {
        return;
      }

      state.commitMessageLanguage = commitMessageLanguage.value || 'auto';

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
      hideContextMenu();
      renderProviders();
      renderForm();
    }

    function scheduleSave() {
      syncFormToState();
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      setSaveStatus('Saving...');
      saveTimer = setTimeout(() => {
        vscode.postMessage({
          type: 'save',
          providers: state.providers,
          commitMessageLanguage: state.commitMessageLanguage,
        });
      }, 300);
    }

    function showContextMenu(x, y, index) {
      contextMenuIndex = index;
      providerContextMenu.style.left = x + 'px';
      providerContextMenu.style.top = y + 'px';
      providerContextMenu.classList.remove('hidden');
    }

    function hideContextMenu() {
      contextMenuIndex = -1;
      providerContextMenu.classList.add('hidden');
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
      scheduleSave();
    };

    toggleApiKey.onclick = () => {
      setApiKeyVisibility(!isApiKeyVisible);
    };

    providerName.oninput = () => scheduleSave();
    baseUrl.oninput = () => scheduleSave();
    apiKey.oninput = () => scheduleSave();
    commitMessageLanguage.onchange = () => scheduleSave();

    document.getElementById('addModel').onclick = () => {
      syncFormToState();
      const provider = selectedProvider();
      if (!provider) return;
      provider.models = Array.isArray(provider.models) ? provider.models : [];
      provider.models.push({ id: '', name: '', endpointType: 'OPENAI' });
      renderForm();
      scheduleSave();
    };

    setApiKeyVisibility(false);

    deleteProviderAction.onclick = () => {
      if (contextMenuIndex < 0) return;
      state.providers.splice(contextMenuIndex, 1);
      state.selectedIndex = Math.min(state.selectedIndex, state.providers.length - 1);
      render();
      scheduleSave();
    };

    window.addEventListener('click', () => hideContextMenu());
    window.addEventListener('blur', () => hideContextMenu());
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideContextMenu();
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'saved') {
        setSaveStatus('Auto-saved');
        return;
      }
      if (msg.type !== 'state') return;
      state.providers = Array.isArray(msg.providers) ? msg.providers : [];
      state.commitMessageLanguage =
        msg.commitMessageLanguage === 'zh-CN' || msg.commitMessageLanguage === 'en'
          ? msg.commitMessageLanguage
          : 'auto';
      setSaveStatus('Auto-saved');
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
