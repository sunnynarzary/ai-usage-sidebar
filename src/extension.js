const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { IDS, publicFailure, publicReady, visible, readClaude, readCursor, readCodex } = require('./core');

const READERS = { claude: readClaude, codex: readCodex, cursor: readCursor };
const CONSENT = { claude: 'claude', codex: 'codex', cursor: 'cursor.ide' };
const CURSOR_ROUTES = Object.freeze(['/aiserver.v1.DashboardService/GetCurrentPeriodUsage', '/aiserver.v1.DashboardService/GetPlanInfo']);
const cursorRequests = CURSOR_ROUTES.map(route => `POST https://api2.cursor.sh${route}`).join(' and ');
const INTERVAL = 30000;
const PERIOD = 300000;
function source() { return vscode.workspace.getConfiguration('aiUsage').get('cursor.source', 'ide'); }
function mode(id) { return vscode.workspace.getConfiguration('aiUsage').get(`cards.${id}`, 'auto'); }
function consentKey(id) { return id === 'cursor' ? `cursor.${source()}` : CONSENT[id]; }
function title(id) { return id === 'cursor' && source() === 'cursor-agent' ? 'Cursor (cursor-agent login)' : ({ claude: 'Claude', codex: 'Codex', cursor: 'Cursor' })[id]; }
function consentText(id) {
  if (id === 'claude') return 'Read the Claude Code-credentials macOS Keychain item and/or $CLAUDE_CONFIG_DIR/.credentials.json and ~/.claude/.credentials.json. Send the access token to GET https://api.anthropic.com/api/oauth/usage. This endpoint is unofficial; using it may carry account or terms risk.';
  if (id === 'codex') return 'Start the installed local Codex CLI and request account/rateLimits/read. The CLI manages its own login and network requests.';
  if (source() === 'cursor-agent') return `Read the cursor-access-token macOS Keychain item. Send the token to ${cursorRequests}. This source is unavailable on Windows. These endpoints are unofficial; using them may carry account or terms risk.`;
  return `Read Cursor IDE User/globalStorage/state.vscdb, key cursorAuth/accessToken (macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb; Windows: %APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb). Send the token to ${cursorRequests}. These endpoints are unofficial; using them may carry account or terms risk.`;
}
class Dashboard {
  constructor(context, readers = READERS) {
    this.context = context; this.view = null; this.timer = null; this.generation = 0; this.running = new Set(); this.controllers = new Map();
    this.readers = readers;
    this.lastSource = source();
    this.blockedSource = this.lastSource;
    this.pendingSourcePrompt = false;
    this.data = Object.fromEntries(IDS.map(id => [id, { state: 'notEnabled' }]));
    this.sourceReady = this.initializeSource();
  }
  async initializeSource() {
    const selected = this.lastSource;
    const previous = this.context.globalState.get('cursor.selectedSource');
    if (previous !== selected) {
      await this.context.globalState.update(`consent.cursor.${selected}`, false);
      await this.context.globalState.update('cursor.selectedSource', selected);
      this.pendingSourcePrompt = previous !== undefined;
    } else this.blockedSource = null;
    this.reconcile();
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(m => {
      if (m?.type === 'ready') { this.publish(); this.tick(true); }
      else if (m?.type === 'enable' && IDS.includes(m.id)) void this.enable(m.id);
      else if (m?.type === 'refresh' && IDS.includes(m.id)) void this.refresh(m.id);
      else if (m?.type === 'manage') void this.manage();
    }, null, this.context.subscriptions);
    view.onDidChangeVisibility(() => { if (view.visible) this.tick(true); }, null, this.context.subscriptions);
    view.onDidDispose(() => { this.view = null; clearInterval(this.timer); this.timer = null; this.abortAll(); }, null, this.context.subscriptions);
    this.reconcile();
    void this.sourceReady.then(() => { if (this.pendingSourcePrompt && this.view && mode('cursor') !== 'never') { this.pendingSourcePrompt = false; return this.enable('cursor'); } });
    this.timer = setInterval(() => this.tick(), INTERVAL);
  }
  enabled(id) { return !(id === 'cursor' && (this.blockedSource === source() || this.context.globalState.get('cursor.selectedSource') !== source())) && this.context.globalState.get(`consent.${consentKey(id)}`, false) === true; }
  async enable(id) {
    if (mode(id) === 'never') return;
    if (id === 'cursor') await this.sourceReady;
    const key = consentKey(id);
    const choice = await vscode.window.showInformationMessage(`Enable ${title(id)}? ${consentText(id)}`, { modal: true }, 'Enable');
    if (choice !== 'Enable' || key !== consentKey(id)) return;
    await this.context.globalState.update(`consent.${key}`, true);
    if (id === 'cursor') this.blockedSource = null;
    this.reconcile(); this.tick(true);
  }
  async disable(id) {
    this.controllers.get(id)?.abort();
    await this.context.globalState.update(`consent.${consentKey(id)}`, false);
    this.generation++; this.reconcile();
  }
  async manage() {
    const items = IDS.filter(id => mode(id) !== 'never').map(id => ({ label: `${this.enabled(id) ? 'Disable' : 'Enable'} ${title(id)}`, action: 'toggle', id }));
    items.push({ label: `Cursor source: ${source()}`, action: 'source' });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Manage AI Usage tools' });
    if (!picked) return;
    if (picked.action === 'source') {
      const next = await vscode.window.showQuickPick(['ide', 'cursor-agent'], { placeHolder: 'Choose Cursor login source' });
      if (next && next !== source()) await vscode.workspace.getConfiguration('aiUsage').update('cursor.source', next, vscode.ConfigurationTarget.Global);
    } else if (this.enabled(picked.id)) await this.disable(picked.id);
    else await this.enable(picked.id);
  }
  async settingsChanged(e) {
    if (!e.affectsConfiguration('aiUsage')) return;
    if (source() !== this.lastSource) this.blockedSource = source();
    await this.sourceReady;
    this.generation++;
    this.abortAll();
    const changedSource = source() !== this.lastSource;
    if (changedSource) this.blockedSource = source();
    this.lastSource = source();
    if (changedSource) { await this.context.globalState.update(`consent.cursor.${source()}`, false); await this.context.globalState.update('cursor.selectedSource', source()); }
    for (const id of IDS) if (mode(id) === 'never') await this.context.globalState.update(`consent.${consentKey(id)}`, false);
    this.reconcile(); this.tick(true);
    if (changedSource && mode('cursor') !== 'never') await this.enable('cursor');
  }
  reconcile() {
    for (const id of IDS) {
      if (mode(id) === 'never') this.data[id] = { state: 'notEnabled' };
      else if (!this.enabled(id)) this.data[id] = { state: 'notEnabled' };
      else if (this.data[id].state === 'notEnabled') this.data[id] = { state: 'loading' };
    }
    this.publish();
  }
  tick(force = false) {
    if (!this.view?.visible) return;
    for (const id of IDS) if (mode(id) !== 'never' && this.enabled(id) && (force || Date.now() - (this.data[id].checkedAt || 0) >= PERIOD)) void this.refresh(id);
  }
  async refresh(id) {
    if (mode(id) === 'never' || !this.enabled(id) || this.running.has(id)) return;
    const generation = this.generation, key = consentKey(id);
    const controller = new AbortController(); this.controllers.set(id, controller);
    this.running.add(id); this.data[id] = { ...this.data[id], state: 'loading' }; this.publish();
    let result;
    try { result = { state: 'ready', ...publicReady(id === 'cursor' ? await this.readers[id](source(), { signal: controller.signal }) : await this.readers[id]({ signal: controller.signal })), updatedAt: Date.now() }; }
    catch (error) { result = publicFailure(error); }
    this.controllers.delete(id);
    this.running.delete(id);
    if (generation !== this.generation || key !== consentKey(id) || mode(id) === 'never' || !this.enabled(id)) { if (this.enabled(id) && mode(id) !== 'never') { this.data[id].checkedAt = 0; this.tick(true); } return; }
    this.data[id] = { ...result, checkedAt: Date.now() }; this.publish();
  }
  publish() {
    const payload = { type: 'state' };
    for (const id of IDS) payload[id] = { ...this.data[id], title: title(id), visible: visible(mode(id), this.data[id].state) };
    this.view?.webview.postMessage(payload);
  }
  html(webview) {
    const nonce = randomBytes(18).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dashboard.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dashboard.css'));
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>AI Usage</title></head><body><main><button id="manage">Manage tools</button>${IDS.map(id => `<section class="provider" id="${id}-card" aria-labelledby="${id}-title"><header><h2 id="${id}-title"></h2><span id="${id}-plan" class="muted"></span></header><div id="${id}-usage" class="usage-list"></div><div id="${id}-note" class="note"></div><div class="actions" id="${id}-actions"></div></section>`).join('')}</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  abortAll() { for (const controller of this.controllers.values()) controller.abort(); }
  dispose() { clearInterval(this.timer); this.generation++; this.abortAll(); }
}
function activate(context) {
  const dashboard = new Dashboard(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiUsage.dashboard', dashboard),
    vscode.commands.registerCommand('aiUsage.refresh', () => dashboard.tick(true)),
    vscode.commands.registerCommand('aiUsage.manageTools', () => dashboard.manage()),
    vscode.workspace.onDidChangeConfiguration(e => dashboard.settingsChanged(e)), dashboard);
}
function deactivate() {}
module.exports = { activate, deactivate, Dashboard, consentText, CURSOR_ROUTES };
