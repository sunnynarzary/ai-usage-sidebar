const vscode = acquireVsCodeApi();
const IDS = ['claude', 'codex', 'cursor'];
let latest;
vscode.postMessage({ type: 'ready' });
document.getElementById('manage').addEventListener('click', () => vscode.postMessage({ type: 'manage' }));
window.addEventListener('message', event => { if (event.data?.type === 'state') { latest = event.data; render(); } });
setInterval(() => { if (latest) render(); }, 30000);
function button(label, type, id) { const el = document.createElement('button'); el.textContent = label; el.addEventListener('click', () => vscode.postMessage({ type, id })); return el; }
function render() {
  for (const id of IDS) {
    const data = latest[id] || {};
    const section = document.getElementById(`${id}-card`);
    section.hidden = !data.visible;
    if (section.hidden) continue;
    document.getElementById(`${id}-title`).textContent = data.state === 'notEnabled' ? `Enable ${data.title || id}…` : data.title || id;
    document.getElementById(`${id}-plan`).textContent = data.plan || '';
    const usage = document.getElementById(`${id}-usage`); usage.replaceChildren();
    if (data.state === 'ready') for (const item of data.rows || []) usage.append(makeRow(item));
    const note = document.getElementById(`${id}-note`);
    note.textContent = data.state === 'ready' ? [...(data.notes || []), `Updated ${relative(data.updatedAt)}`].join(' · ') : data.state === 'loading' ? 'Refreshing…' : data.message || '';
    const actions = document.getElementById(`${id}-actions`);
    actions.replaceChildren(data.state === 'notEnabled' ? button('Enable', 'enable', id) : button('Refresh', 'refresh', id));
    section.classList.toggle('compact', data.state === 'notEnabled');
  }
}
function makeRow(item) {
  const wrap = document.createElement('div'); wrap.className = 'usage-row';
  const head = document.createElement('div'); head.className = 'usage-heading';
  const label = document.createElement('span'); label.textContent = item.label || 'Usage';
  const pct = document.createElement('span'); pct.textContent = `${Math.round(item.used || 0)}%`; head.append(label,pct);
  const track = document.createElement('progress'); track.className = 'usage-progress'; track.max = 100; track.value = Math.max(0,Math.min(100,item.used || 0));
  wrap.append(head,track);
  if (item.detail) { const detail = document.createElement('div'); detail.className = 'reset-time'; detail.textContent = item.detail; wrap.append(detail); }
  if (item.resetsAt) { const reset = document.createElement('div'); reset.className = 'reset-time'; reset.textContent = `Resets in ${relativeReset(item.resetsAt)}`; wrap.append(reset); }
  return wrap;
}
function relative(ms) { if (!ms) return 'just now'; const minutes = Math.max(0,Math.floor((Date.now()-ms)/60000)); return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes/60)}h ago`; }
function relativeReset(seconds) { const minutes = Math.max(0,Math.ceil((seconds*1000-Date.now())/60000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes/60)}h ${minutes%60}m`; }
