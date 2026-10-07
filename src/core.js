const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');

const IDS = ['claude', 'codex', 'cursor'];
const STATES = new Set(['notEnabled', 'signedOut', 'expired', 'unavailable', 'error', 'ready']);
const ORIGINS = Object.freeze({ claude: 'https://api.anthropic.com', cursor: 'https://api2.cursor.sh' });
const MESSAGES = Object.freeze({
  notEnabled: 'Enable this tool to show usage.', signedOut: 'No local login found.',
  expired: 'Open Claude Code to refresh your login.', unavailable: 'Usage is unavailable in this editor or login format.',
  error: 'Could not load usage. Check your login or connection and retry.'
});
const EXTRA_MESSAGES = new Set(['Cursor login not readable in this editor version.', 'cursor-agent login is unavailable on this platform.', 'Codex CLI was not found.', 'Open Cursor to refresh your login.']);
const PUBLIC_LABELS = new Set(['Session (5hr)', 'Weekly (7 day)', 'Model usage', 'Extra usage', 'Included usage', 'Auto models', 'API models', 'Team on-demand', 'On-demand', 'Session', 'Weekly', 'Spend limit']);
const PUBLIC_MODELS = /^(?:Claude )?(?:Opus|Sonnet|Haiku)(?: [0-9](?:\.[0-9])?)?$/;
const PUBLIC_PLANS = new Set(['Free', 'Pro', 'Pro Plus', 'Ultra', 'Teams', 'Enterprise', 'Plus', 'Business', 'Edu']);
const PUBLIC_NOTES = new Set(['Extra usage limit reached.']);
class ProviderError extends Error { constructor(state, message) { super(message || MESSAGES[state]); this.state = state; } }
const failure = (state, message) => new ProviderError(state, message);
function publicFailure(error) {
  const state = STATES.has(error?.state) && error.state !== 'ready' ? error.state : 'error';
  return { state, message: error instanceof ProviderError && EXTRA_MESSAGES.has(error.message) ? error.message : MESSAGES[state] };
}
function publicReady(data) {
  const rows = (Array.isArray(data?.rows) ? data.rows : []).slice(0, 20).filter(r => PUBLIC_LABELS.has(r?.label) || typeof r?.label === 'string' && r.label.endsWith(' (7 day)') && PUBLIC_MODELS.test(r.label.slice(0, -8))).map(r => ({ label: r.label, used: percentage(r.used), resetsAt: Number.isFinite(Number(r.resetsAt)) && Number(r.resetsAt) > 0 ? Number(r.resetsAt) : null, detail: typeof r.detail === 'string' && r.detail.length <= 100 && /^\$[0-9,]{1,15}\.[0-9]{2} of \$[0-9,]{1,15}\.[0-9]{2}(?: this month|(?: · \+\$[0-9,]{1,15}\.[0-9]{2} bonus)?| · you \$[0-9,]{1,15}\.[0-9]{2})?$/.test(r.detail) ? r.detail : '' }));
  return { rows, notes: (Array.isArray(data?.notes) ? data.notes : []).filter(n => PUBLIC_NOTES.has(n)), plan: PUBLIC_PLANS.has(data?.plan) ? data.plan : '' };
}
function visible(mode, state) { return mode !== 'never' && (mode === 'always' || state !== 'signedOut'); }
function percentage(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
function row(label, used, resetsAt) { return { label, used: percentage(used), resetsAt: Number(resetsAt) || null }; }
function dollars(value) { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 && n <= 1e11 ? `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null; }
function claudeMoney(value) { const minor = Number(value?.amount_minor), exponent = Number(value?.exponent); return Number.isSafeInteger(minor) && minor >= 0 && minor <= 1e11 && Number.isInteger(exponent) && exponent >= 0 && exponent <= 4 ? dollars(Math.round(minor * 100 / 10 ** exponent)) : null; }
function normalizeClaude(data) {
  const rows = (Array.isArray(data?.limits) ? data.limits : []).map((limit) => {
    const model = limit.scope?.model?.display_name;
    const label = limit.kind === 'session' ? 'Session (5hr)' : limit.kind === 'weekly_all' ? 'Weekly (7 day)' : typeof model === 'string' && PUBLIC_MODELS.test(model) ? `${model} (7 day)` : 'Model usage';
    return row(label, limit.percent, Date.parse(limit.resets_at) / 1000);
  });
  const spend = data?.spend;
  const notes = [];
  if (spend?.enabled && Number(spend?.limit?.amount_minor) > 0) {
    const extra = row('Extra usage', spend.percent);
    const used = claudeMoney(spend.used), cap = claudeMoney(spend.limit);
    if (used && cap) extra.detail = `${used} of ${cap} this month`;
    rows.push(extra);
    if (Number(spend.percent) >= 100) notes.push('Extra usage limit reached.');
  }
  return { rows, notes };
}
function normalizeCursor(data) {
  const p = data?.planUsage; const rows = [];
  const resetsAt = Number(data?.billingCycleEnd) / 1000;
  if (p) { const included = row('Included usage', p.totalPercentUsed, resetsAt); const used = dollars(p.includedSpend), cap = dollars(p.limit), bonus = dollars(p.bonusSpend); if (used && cap) included.detail = `${used} of ${cap}${Number(p.bonusSpend) > 0 && bonus ? ` · +${bonus} bonus` : ''}`; rows.push(included); if (p.autoPercentUsed != null) rows.push(row('Auto models', p.autoPercentUsed, resetsAt)); if (p.apiPercentUsed != null) rows.push(row('API models', p.apiPercentUsed, resetsAt)); }
  const onDemand = data?.spendLimitUsage;
  const cap = Number(onDemand?.pooledLimit);
  if (cap > 0) { const extra = row(onDemand.limitType === 'team' ? 'Team on-demand' : 'On-demand', Number(onDemand.pooledUsed) / cap * 100, resetsAt); const used = dollars(onDemand.pooledUsed), limit = dollars(cap), yours = dollars(onDemand.individualUsed); if (used && limit) extra.detail = `${used} of ${limit}${onDemand.limitType === 'team' && yours ? ` · you ${yours}` : ''}`; rows.push(extra); }
  return { rows, notes: [] };
}
function normalizeCodex(data) {
  const limits = data?.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length ? data.rateLimitsByLimitId : data?.rateLimits ? { codex: data.rateLimits } : {};
  const rows = [];
  for (const limit of Object.values(limits)) for (const [name, bucket] of [['Session', limit?.primary], ['Weekly', limit?.secondary]]) if (bucket) rows.push(row(name, bucket.usedPercent, bucket.resetsAt));
  for (const limit of Object.values(limits)) {
    const spend = limit?.individualLimit;
    const cap = Number(spend?.limit);
    if (cap > 0) rows.push(row('Spend limit', Number(spend.used) / cap * 100, spend.resetsAt));
  }
  const plans = { free: 'Free', plus: 'Plus', pro: 'Pro', pro_plus: 'Pro Plus', business: 'Business', team: 'Teams', enterprise: 'Enterprise', edu: 'Edu', self_serve_plus: 'Plus', self_serve_pro: 'Pro' };
  return { rows, notes: [], plan: plans[data?.rateLimits?.planType] || '' };
}
function checkSignal(signal) { if (signal?.aborted) throw failure('error'); }
function keychain(service, exec = execFile, signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => exec('security', ['find-generic-password', '-s', service, '-w'], { timeout: 10000, signal }, (error, stdout) => {
    if (signal?.aborted) { reject(failure('error')); return; }
    if (error?.code === 44) reject(failure('signedOut'));
    else if (error) reject(failure('error'));
    else resolve(stdout.trim());
  }));
}
async function fileCredential(file, io = fs.promises, signal) {
  checkSignal(signal);
  try { const contents = await io.readFile(file, { encoding: 'utf8', signal }); checkSignal(signal); return JSON.parse(contents); }
  catch (error) { if (error?.code === 'ENOENT') throw failure('signedOut'); throw failure(error instanceof SyntaxError ? 'unavailable' : 'error'); }
}
function claudePaths(env = process.env, home = os.homedir(), platform = process.platform) {
  const join = platform === 'win32' ? path.win32.join : path.join;
  return [...new Set([env.CLAUDE_CONFIG_DIR && join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), join(home, '.claude', '.credentials.json')].filter(Boolean))];
}
async function claudeToken(deps = {}) {
  const platform = deps.platform || process.platform, env = deps.env || process.env, home = deps.home || os.homedir();
  const candidates = [];
  let error;
  checkSignal(deps.signal);
  if (platform === 'darwin') {
    try { candidates.push(JSON.parse(await (deps.keychain || keychain)('Claude Code-credentials', undefined, deps.signal))?.claudeAiOauth); checkSignal(deps.signal); }
    catch (e) { if (e instanceof SyntaxError) error = failure('unavailable'); else if (e.state !== 'signedOut') error = e; }
  }
  for (const file of claudePaths(env, home, platform)) {
    checkSignal(deps.signal);
    try { candidates.push((await (deps.fileCredential || fileCredential)(file, undefined, deps.signal))?.claudeAiOauth); checkSignal(deps.signal); }
    catch (e) { if (e.state !== 'signedOut') error = e; }
  }
  checkSignal(deps.signal);
  const valid = candidates.filter((c) => typeof c?.accessToken === 'string' && c.accessToken);
  if (!valid.length) throw error || failure(candidates.length ? 'unavailable' : 'signedOut');
  const best = valid.sort((a,b) => Number(b.expiresAt || 0) - Number(a.expiresAt || 0))[0];
  if (best.expiresAt && best.expiresAt <= Date.now()) throw failure('expired');
  return best.accessToken;
}
function cursorDbPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}
async function cursorIdeToken(deps = {}) {
  checkSignal(deps.signal);
  const file = deps.file || cursorDbPath(deps.platform, deps.env, deps.home);
  let SQLite;
  try { SQLite = deps.sqlite || require('node:sqlite'); } catch { SQLite = null; }
  if (SQLite?.DatabaseSync) {
    let db;
    try {
      db = new SQLite.DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: false });
      const record = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('cursorAuth/accessToken');
      checkSignal(deps.signal);
      if (!record) throw failure('signedOut');
      if (typeof record.value !== 'string' || !record.value) throw failure('unavailable');
      return record.value;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error?.code === 'ENOENT' || /unable to open database file/.test(error?.message) && !fs.existsSync(file)) throw failure('signedOut');
      throw failure(/no such table|no such column/i.test(error?.message) ? 'unavailable' : 'error');
    } finally { db?.close(); }
  }
  let stat;
  checkSignal(deps.signal);
  try { stat = await fs.promises.stat(`${file}-wal`); } catch (e) { if (e.code !== 'ENOENT') throw failure('error'); }
  if (stat?.size) throw failure('unavailable', 'Cursor login not readable in this editor version.');
  try {
    const init = deps.sqljs || require('sql.js');
    const SQL = await init(); checkSignal(deps.signal); const db = new SQL.Database(await fs.promises.readFile(file, { signal: deps.signal })); checkSignal(deps.signal);
    try { const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"); const value = result?.[0]?.values?.[0]?.[0]; if (!value) throw failure('signedOut'); return String(value); }
    finally { db.close(); }
  } catch (e) { if (e instanceof ProviderError) throw e; if (e.code === 'ENOENT') throw failure('signedOut'); throw failure('unavailable', 'Cursor login not readable in this editor version.'); }
}
async function cursorToken(source, deps = {}) {
  checkSignal(deps.signal);
  if (source === 'ide') return checkCursorExpiry(await cursorIdeToken(deps));
  if (source !== 'cursor-agent') throw failure('unavailable');
  if ((deps.platform || process.platform) !== 'darwin') throw failure('unavailable', 'cursor-agent login is unavailable on this platform.');
  const token = await (deps.keychain || keychain)('cursor-access-token', undefined, deps.signal);
  checkSignal(deps.signal);
  return checkCursorExpiry(token);
}
function checkCursorExpiry(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now()) throw failure('expired', 'Open Cursor to refresh your login.');
  } catch (error) { if (error instanceof ProviderError) throw error; }
  return token;
}
async function vendorFetch(origin, route, options, fetcher = fetch) {
  const url = new URL(route, origin);
  if (!Object.values(ORIGINS).includes(origin) || url.origin !== origin || url.protocol !== 'https:') throw failure('unavailable');
  checkSignal(options?.signal);
  const response = await fetcher(url.toString(), { ...options, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(options?.signal ? [options.signal] : [])]) });
  checkSignal(options?.signal);
  if (!response.ok) throw failure('error');
  try { const data = await response.json(); checkSignal(options?.signal); return data; } catch { throw failure('unavailable'); }
}
async function readClaude(deps = {}) {
  const token = await claudeToken(deps);
  checkSignal(deps.signal);
  const data = await vendorFetch(ORIGINS.claude, '/api/oauth/usage', { signal: deps.signal, headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' } }, deps.fetch);
  return normalizeClaude(data);
}
async function readCursor(source, deps = {}) {
  const token = await cursorToken(source, deps);
  const data = await vendorFetch(ORIGINS.cursor, '/aiserver.v1.DashboardService/GetCurrentPeriodUsage', { signal: deps.signal, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' }, deps.fetch);
  checkSignal(deps.signal);
  const plan = await vendorFetch(ORIGINS.cursor, '/aiserver.v1.DashboardService/GetPlanInfo', { signal: deps.signal, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' }, body: '{}' }, deps.fetch).catch(() => null);
  checkSignal(deps.signal);
  const result = normalizeCursor(data);
  const knownPlans = new Set(['Free', 'Pro', 'Pro Plus', 'Ultra', 'Teams', 'Enterprise']);
  if (knownPlans.has(plan?.planInfo?.planName)) result.plan = plan.planInfo.planName;
  return result;
}
function resolveCodex(platform = process.platform, env = process.env, exists = fs.existsSync, home = os.homedir(), arch = process.arch, execPath = process.execPath) {
  const p = platform === 'win32' ? path.win32 : path;
  const dirs = (env.PATH || '').split(p.delimiter).filter(Boolean);
  if (platform !== 'win32') dirs.push(p.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const dir of dirs) {
    const exe = p.join(dir, platform === 'win32' ? 'codex.exe' : 'codex');
    if (exists(exe)) return { command: exe, args: [] };
    if (platform === 'win32' && exists(p.join(dir, 'codex.cmd'))) {
      const target = arch === 'arm64' ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc'] : arch === 'x64' ? ['codex-win32-x64', 'x86_64-pc-windows-msvc'] : null;
      for (const base of [dir, p.resolve(dir, '..')]) {
        const modules = p.join(base, 'node_modules');
        const root = p.join(modules, '@openai', 'codex');
        if (target) for (const packageRoot of [p.join(root, 'node_modules', '@openai', target[0]), p.join(modules, '@openai', target[0])]) {
          const native = p.join(packageRoot, 'vendor', target[1], 'bin', 'codex.exe');
          if (exists(native)) return { command: native, args: [] };
        }
        if (target) {
          const legacy = p.join(root, 'vendor', target[1], 'codex', 'codex.exe');
          if (exists(legacy)) return { command: legacy, args: [] };
        }
        const js = p.join(root, 'bin', 'codex.js');
        const nodes = [execPath, ...dirs.map(d => p.join(d, 'node.exe'))].filter(n => p.basename(n).toLowerCase() === 'node.exe');
        const node = nodes.find(exists);
        if (exists(js) && node) return { command: node, args: [js] };
      }
    }
  }
  throw failure('unavailable', 'Codex CLI was not found.');
}
function killTree(child, platform = process.platform, exec = execFile) {
  if (!child?.pid) return;
  if (platform === 'win32') exec('taskkill', ['/T', '/F', '/PID', String(child.pid)], { timeout: 10000 }, () => {});
  else child.kill();
}
function readCodex(deps = {}) {
  if (deps.signal?.aborted) return Promise.reject(failure('error'));
  const spec = (deps.resolveCodex || resolveCodex)();
  const child = (deps.spawn || spawn)(spec.command, [...spec.args, 'app-server', '--listen', 'stdio://'], { stdio: ['pipe','pipe','ignore'], shell: false, windowsHide: true });
  return new Promise((resolve, reject) => {
    let id = 0; const pending = new Map(); let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timeout); lineReader.close(); killTree(child, deps.platform, deps.execFile); error ? reject(error) : resolve(value); };
    const send = (method, params) => { const next = ++id; pending.set(next, method); child.stdin.write(JSON.stringify({ id: next, method, params }) + '\n'); };
    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (!pending.has(msg.id)) return;
      const method = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) return finish(/not logged in|unauthorized/i.test(`${String(msg.error.code || '')} ${String(msg.error.message || '')}`) ? failure('signedOut') : failure('error'));
      if (method === 'initialize') { child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'); send('account/rateLimits/read', {}); }
      else finish(null, normalizeCodex(msg.result));
    });
    child.on('error', () => finish(failure('error')));
    child.stdin.on('error', () => finish(failure('error')));
    child.on('exit', () => finish(failure('error')));
    const timeout = setTimeout(() => finish(failure('error')), 15000);
    deps.signal?.addEventListener('abort', () => finish(failure('error')), { once: true });
    send('initialize', { clientInfo: { name: 'ai_usage_sidebar', title: 'AI Usage', version: '0.1.0' } });
  });
}
module.exports = { IDS, STATES, MESSAGES, ORIGINS, ProviderError, publicFailure, publicReady, visible, normalizeClaude, normalizeCursor, normalizeCodex, claudePaths, claudeToken, cursorDbPath, cursorIdeToken, cursorToken, resolveCodex, killTree, readClaude, readCursor, readCodex, vendorFetch };
