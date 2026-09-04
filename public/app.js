/* Mission Control — frontend */
'use strict';

// Two kinds of thing (Round 5): registered agents are definitions (type, models,
// pricing, env) and never chat; instances are live sessions of one agent on
// one project. Every per-session map below is keyed by instance id.
const state = {
  agents: [],            // registered agents [{id, name, type, description, accent, available, instances:[iid]}]
  instances: [],         // [{id, name, agentId, agent, accent, projectId, status}]
  projects: [],          // [{id, name, path, description, instances, agents}]
  tasks: [],             // kanban cards
  boardProj: undefined,  // selected board project id (null = default workspace)
  histories: {},         // iid -> [events] (this instance's slice of the project history)
  tab: 'chat',           // active tab on instance pages
  wsFile: {},            // iid -> { dir, selected, dirty }
  fileTree: {},          // iid -> { expanded:Set, root, selected } (file trees)
  attach: {},            // iid -> staged uploads / file references for the next message
  drafts: {},            // iid -> unsent composer text, survives instance switches
  skillsCache: {},       // iid -> { at, items } for the composer's `/` picker
  sessionSel: {},        // iid -> selected session cid
  agentCid: {},          // iid -> last seen conversation id (change detection)
  projEdit: null,        // project id currently being edited on Projects page
  voice: null,           // active voice session (M16): recorder or dictation, one at a time
  voiceCfg: null,        // { at, whisperKey } cache for the 🎤 picker
  vault: null,           // Vault page: { sel, editing, draft, q, flaggedOnly, expanded:Set }
  cliSessions: [],       // live external CLI sessions (from /api/cli-sessions)
  cliFetchedAt: 0,
  agentLaunch: null,     // Sidebar launcher: { agentId (open under this agent, or null), projectId, prompt }
  collapsed: new Set(),  // registered agents whose instance list is folded in the sidebar
  connected: false,
};

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

/* ── Utilities ───────────────────────────────────────────────────── */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function toast(msg, isError = false) {
  const t = el('div', { class: 'toast-msg' + (isError ? ' error' : '') }, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Tiny markdown: fenced code, inline code, bold. Everything else stays text.
function renderMarkdown(text) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    let chunk = escapeHtml(parts[i] || '');
    chunk = chunk
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html += chunk
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
    if (i + 2 < parts.length) {
      html += `<pre><code>${escapeHtml(parts[i + 2] || '')}</code></pre>`;
    }
  }
  return html;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function getAgent(id) {
  return state.agents.find((a) => a.id === id);
}

function getInstance(iid) {
  return state.instances.find((i) => i.id === iid);
}

function instancesOf(agentId) {
  return state.instances.filter((i) => i.agentId === agentId);
}

function modelLabel(status) {
  return status?.model || 'default model';
}

function projName(pid) {
  if (!pid) return 'default ws';
  return state.projects.find((p) => p.id === pid)?.name || pid;
}

/* ── WebSocket ───────────────────────────────────────────────────── */

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    state.connected = true;
    updateConnBadge();
  };
  ws.onclose = () => {
    state.connected = false;
    updateConnBadge();
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMsg(msg);
  };
}

function updateConnBadge() {
  $('#conn-dot').classList.toggle('ok', state.connected);
  $('#conn-label').textContent = state.connected ? 'link established' : 'reconnecting…';
}

function handleServerMsg(msg) {
  if (msg.type === 'hello') {
    state.agents = msg.agents;
    state.instances = msg.instances || [];
    if (msg.projects) state.projects = msg.projects;
    if (msg.tasks) state.tasks = msg.tasks;
    renderSidebar();
    route();
    return;
  }
  if (msg.type === 'tasks') {
    state.tasks = msg.tasks;
    if (onBoardPage()) renderBoard();
    return;
  }
  if (msg.type === 'agents') {
    state.agents = msg.agents;
    renderSidebar();
    const cur = currentAgentId();
    if (cur && !getAgent(cur)) { location.hash = '#/'; return; }
    if (cur) renderAgentDetail(getAgent(cur));
    else if (!currentInstanceId() && !onOtherPage()) renderHome();
    return;
  }
  if (msg.type === 'instances') {
    // Statuses arrive on their own channel; keep whatever is newer than the
    // list snapshot so a status that raced the broadcast isn't lost.
    const prev = new Map(state.instances.map((i) => [i.id, i.status]));
    state.instances = msg.instances.map((i) => ({ ...i, status: i.status || prev.get(i.id) }));
    renderSidebar();
    const cur = currentInstanceId();
    if (cur && !getInstance(cur)) { location.hash = '#/'; return; }
    if (currentAgentId()) renderAgentDetail(getAgent(currentAgentId()));
    else if (onBoardPage()) renderBoard();
    else if (!cur && !onOtherPage()) renderHome();
    return;
  }
  if (msg.type === 'projects') {
    state.projects = msg.projects;
    if (onProjectsPage()) renderProjects();
    else if (!currentInstanceId() && !currentAgentId() && !onOtherPage()) renderHome();
    populateLauncherProjects();
    return;
  }
  if (msg.type === 'instance_partial') {
    if (currentInstanceId() === msg.iid && state.tab === 'chat') updatePartialBubble(msg.text);
    return;
  }
  if (msg.type === 'instance_status') {
    const inst = getInstance(msg.iid);
    if (inst) inst.status = msg.status;
    renderSidebar();
    onStatusChanged(msg.iid);
    return;
  }
  if (msg.type === 'instance_event') {
    (state.histories[msg.iid] ||= []).push(msg.event);
    if (onAnalyticsPage()) {
      clearTimeout(state.anTimer);
      state.anTimer = setTimeout(renderAnalytics, 700);
      return;
    }
    onAgentEvent(msg.iid, msg.event);
    return;
  }
  if (msg.type === 'history_cleared') {
    state.histories[msg.iid] = [];
    if (currentInstanceId() === msg.iid) route();
  }
}

/* ── Routing ─────────────────────────────────────────────────────── */

// `#/instance/<iid>` is the Control Room for one live session;
// `#/agent/<id>` is a registered agent's definition page.
function currentInstanceId() {
  const m = location.hash.match(/^#\/instance\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function currentAgentId() {
  const m = location.hash.match(/^#\/agent\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function onProjectsPage() {
  return location.hash.startsWith('#/projects');
}

// `#/project/<id>` — the project's conversations; `#/project/<id>/<cid>`
// opens one of them.
function currentProjectHistoryId() {
  const m = location.hash.match(/^#\/project\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function currentProjectCid() {
  const m = location.hash.match(/^#\/project\/[^/]+\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function onBoardPage() {
  return location.hash.startsWith('#/board');
}

function onVaultPage() {
  return location.hash.startsWith('#/vault');
}

function onAlertsPage() {
  return location.hash.startsWith('#/alerts');
}

function onAnalyticsPage() {
  return location.hash.startsWith('#/analytics');
}

// True on any route that isn't the agent view or the home dashboard, so
// background broadcasts (agent/project list updates) don't yank the user
// back to the dashboard while they're looking at one of these pages.
function onOtherPage() {
  return onProjectsPage() || onBoardPage() || onAlertsPage() || onAnalyticsPage() || onVaultPage() || !!currentProjectHistoryId() || !!currentAgentId();
}

async function route() {
  const iid = currentInstanceId();
  renderSidebar();
  if (onProjectsPage()) return renderProjects();
  if (currentProjectHistoryId()) return renderProjectHistory(currentProjectHistoryId());
  if (onBoardPage()) return renderBoard();
  if (onAlertsPage()) return renderAlerts();
  if (onAnalyticsPage()) return renderAnalytics();
  if (onVaultPage()) return renderVault();
  if (currentAgentId()) {
    const agent = getAgent(currentAgentId());
    return agent ? renderAgentDetail(agent) : renderHome();
  }
  if (!iid) return renderHome();
  const inst = getInstance(iid);
  if (!inst) return renderHome();
  if (!state.histories[iid]) {
    try { state.histories[iid] = await api(`/api/instances/${iid}/history`); }
    catch { state.histories[iid] = []; }
  }
  renderAgentPage(inst);
}

window.addEventListener('hashchange', route);

/* ── Sidebar ─────────────────────────────────────────────────────── */

// Agents section: one row per registered agent, its instances nested beneath
// (status dot, project, queue badge, close ✕ when idle), a ▶ per agent that
// expands the launcher in place, and "+ Register agent" at the bottom.
function renderSidebar() {
  const iid = currentInstanceId();
  const aid = currentAgentId();
  $('.nav-item[data-route="home"]').classList.toggle('active', !iid && !aid && !onOtherPage());
  $('.nav-item[data-route="projects"]').classList.toggle('active', onProjectsPage() || !!currentProjectHistoryId());
  $('.nav-item[data-route="board"]').classList.toggle('active', onBoardPage());
  $('.nav-item[data-route="alerts"]').classList.toggle('active', onAlertsPage());
  $('.nav-item[data-route="analytics"]').classList.toggle('active', onAnalyticsPage());
  $('.nav-item[data-route="vault"]').classList.toggle('active', onVaultPage());
  const nav = $('#agent-nav');
  const f = agentLaunchState();
  // Rebuilding the list would yank focus out of the launcher / register form
  // mid-keystroke (status broadcasts arrive constantly during a run), so
  // while a field in the sidebar is focused the re-render waits for blur.
  const focused = document.activeElement;
  if (focused && nav.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) {
    if (!state.navDeferred) {
      state.navDeferred = true;
      focused.addEventListener('blur', () => { state.navDeferred = false; renderSidebar(); }, { once: true });
    }
    return;
  }
  nav.replaceChildren(
    ...state.agents.map((a) => {
      const kids = instancesOf(a.id);
      const folded = state.collapsed.has(a.id);
      const working = kids.filter((i) => i.status?.state === 'working').length;
      return el('div', { class: 'nav-agent' + (a.available ? '' : ' unavailable') },
        el('div', { class: 'nav-item nav-agent-row' + (a.id === aid ? ' active' : '') },
          el('button', {
            class: 'nav-fold', title: folded ? 'Show instances' : 'Hide instances',
            onclick: () => {
              if (folded) state.collapsed.delete(a.id); else state.collapsed.add(a.id);
              renderSidebar();
            },
          }, kids.length ? (folded ? '▸' : '▾') : '·'),
          el('a', {
            class: 'nav-agent-link', href: `#/agent/${encodeURIComponent(a.id)}`,
            style: `--agent-accent:${a.accent || 'var(--accent)'}`,
            title: a.available ? a.description || a.name : `${a.name} — CLI not available`,
          },
            el('span', { class: 'nav-agent-swatch' }),
            el('span', { class: 'nav-agent-name' }, a.name),
          ),
          kids.length ? el('span', {
            class: 'nav-count' + (working ? ' working' : ''),
            title: `${kids.length} instance${kids.length === 1 ? '' : 's'}${working ? `, ${working} working` : ''}`,
          }, working ? `${working}/${kids.length}` : String(kids.length)) : null,
          el('button', {
            class: 'nav-launch-btn' + (f.agentId === a.id ? ' active' : ''),
            title: `Launch a ${a.name} instance`,
            onclick: () => (f.agentId === a.id ? closeLauncher() : openAgentLauncher(a.id)),
          }, f.agentId === a.id ? '−' : '▶'),
        ),
        f.agentId === a.id ? agentLauncher() : null,
        folded ? null : kids.map((i) => instanceNavRow(i, i.id === iid)),
      );
    }),
    registerNode(),
  );
  if (!state.agents.length) {
    nav.prepend(el('div', { class: 'nav-empty' }, 'No agents registered yet.'));
  }
}

function instanceNavRow(i, active) {
  const st = i.status || {};
  const busy = st.state === 'working';
  return el('a', {
    class: 'nav-item nav-instance' + (active ? ' active' : ''),
    href: `#/instance/${encodeURIComponent(i.id)}`,
    title: `${i.name} · ${modelLabel(st)}`,
  },
    el('span', { class: `dot ${st.state || 'offline'}` }),
    el('span', { class: 'nav-agent-col' },
      el('span', { class: 'nav-agent-name' }, projName(i.projectId)),
      el('span', { class: 'nav-agent-model' }, busy ? (st.currentTask || 'working…') : modelLabel(st)),
    ),
    st.queue?.length
      ? el('span', { class: 'nav-queue-badge', title: 'queued tasks' }, String(st.queue.length))
      : null,
    el('button', {
      class: 'nav-close', disabled: busy ? '' : null,
      title: busy ? 'Working — abort or wait before closing' : 'Close this instance (its conversation stays in the project history)',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); closeInstance(i); },
    }, '✕'),
  );
}

async function closeInstance(i) {
  try {
    await api('/api/instances/' + encodeURIComponent(i.id), { method: 'DELETE' });
    toast(`Closed ${i.name}`);
    if (currentInstanceId() === i.id) location.hash = '#/';
  } catch (err) { toast(err.message, true); }
}

/* ── Instance launcher (sidebar, per registered agent) ───────────── */

// ▶ on an agent row expands this form beneath it: project (required) and an
// optional first prompt. Form values live in state so sidebar re-renders
// (status broadcasts) never eat what's being typed; the node itself is
// persistent and re-parented rather than rebuilt.
function agentLaunchState() {
  if (!state.agentLaunch) {
    state.agentLaunch = { agentId: null, projectId: '', prompt: '' };
  }
  return state.agentLaunch;
}

let launcherNode = null;

function agentLauncher() {
  const f = agentLaunchState();
  if (launcherNode) { populateLauncherProjects(); return launcherNode; }

  const projSel = el('select', { class: 'hdr-model', id: 'launcher-proj', title: 'Project this instance works in' });
  const promptIn = el('textarea', {
    class: 'launcher-input launcher-prompt', id: 'launcher-prompt',
    placeholder: 'First prompt (optional) — sent the moment the instance starts',
    rows: '3',
    oninput: (e) => { f.prompt = e.target.value; },
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) launchNewInstance();
      if (e.key === 'Escape') closeLauncher();
    },
  });

  launcherNode = el('div', { class: 'nav-launch-form', id: 'nav-launch-form' },
    projSel,
    promptIn,
    el('div', { class: 'nav-launch-foot' },
      el('span', { class: 'nav-launch-hint' }, '⌘↵ to launch'),
      el('button', { class: 'btn primary sm', onclick: launchNewInstance }, 'Launch'),
    ),
  );
  populateLauncherProjects();
  return launcherNode;
}

function populateLauncherProjects() {
  const f = agentLaunchState();
  const sel = $('#launcher-proj');
  if (!sel) return;
  if (!state.projects.some((p) => p.id === f.projectId)) f.projectId = state.projects[0]?.id || '';
  sel.replaceChildren(
    ...(state.projects.length
      ? state.projects.map((p) => el('option', { value: p.id }, '▣ ' + p.name))
      : [el('option', { value: '' }, 'No projects registered')]),
  );
  sel.value = f.projectId;
  sel.onchange = () => { f.projectId = sel.value; };
}

function openAgentLauncher(agentId) {
  const f = agentLaunchState();
  f.agentId = agentId || state.agents[0]?.id || null;
  if (!f.agentId) return toast('Register an agent first', true);
  state.collapsed.delete(f.agentId);
  renderSidebar();
  $('#nav-launch-form')?.scrollIntoView({ block: 'nearest' });
  $('#launcher-prompt')?.focus();
}

function closeLauncher() {
  const f = agentLaunchState();
  f.agentId = null;
  renderSidebar();
}

// Launch an instance of the open agent on the chosen project, send the first
// prompt, and land on its Control Room with the run already streaming.
async function launchNewInstance() {
  const f = agentLaunchState();
  const agent = getAgent(f.agentId);
  if (!agent) return closeLauncher();
  if (!f.projectId) return toast('Pick a project — every instance works in one', true);
  const prompt = f.prompt.trim();
  let inst;
  try {
    inst = await api(`/api/agents/${encodeURIComponent(agent.id)}/instances`, {
      method: 'POST',
      body: { projectId: f.projectId, prompt },
    });
  } catch (err) {
    return toast(err.message, true);
  }
  toast(prompt ? `${inst.name} is running` : `${inst.name} is ready`);
  // Keep the project for the next launch; the prompt resets.
  f.prompt = '';
  const promptNode = $('#launcher-prompt');
  if (promptNode) { promptNode.value = ''; promptNode.style.height = 'auto'; }
  f.agentId = null;
  if (!getInstance(inst.id)) state.instances.push(inst);   // the broadcast may still be in flight
  location.hash = '#/instance/' + encodeURIComponent(inst.id);
}

/* ── Register agent (sidebar) ────────────────────────────────────── */

// "+ Register agent" opens the full definition form (M21) as a modal, so
// sidebar re-renders from status broadcasts never touch what's being typed.
let registerNodeEl = null;

function registerNode() {
  if (registerNodeEl) return registerNodeEl;
  registerNodeEl = el('div', { class: 'nav-launch' },
    el('button', { class: 'nav-item nav-add', onclick: () => openAgentForm(null) },
      el('span', { class: 'nav-icon' }, '+'), 'Register agent'),
  );
  return registerNodeEl;
}

/* ── Agent definition form (register + edit, M21) ───────────────── */

const ACCENT_PRESETS = ['#d97757', '#5eb0ff', '#34d399', '#fbbf24', '#c084fc', '#f472b6'];
const CURRENCY_SIGNS = { USD: '$', GBP: '£', EUR: '€' };
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function fmtMoney(amount, currency = 'USD') {
  const n = Number(amount) % 1 ? Number(amount).toFixed(2) : String(amount);
  const sign = CURRENCY_SIGNS[currency];
  return sign ? sign + n : `${n} ${currency}`;
}

function isRateCard(p) {
  return !!p && typeof p === 'object' && RATE_KEYS.some((k) => k in p);
}

// One line for the agent page and cards: plan · price / period · rate card.
function pricingSummary(p) {
  if (!p) return 'provider list price (as reported by the CLI)';
  const bits = [];
  if (p.plan) {
    bits.push(p.plan + (typeof p.amount === 'number' ? ` · ${fmtMoney(p.amount, p.currency)}/${p.period === 'year' ? 'yr' : 'mo'}` : ''));
  }
  if (p.perMillion) bits.push(p.plan ? 'rate card for list-price estimates' : 'metered at the rate card');
  return bits.join(' · ');
}

function renewalText(p) {
  if (!p?.renewsOn) return null;
  const days = Math.round((Date.parse(p.renewsOn) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5);
  const rel = days < 0 ? `${-days}d overdue` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return { text: `${p.renewsOn} · ${rel}`, days };
}

let agentTypesCache = null;
async function agentTypes() {
  if (!agentTypesCache) {
    try { agentTypesCache = await api('/api/agent-types'); } catch { agentTypesCache = []; }
  }
  return agentTypesCache.length ? agentTypesCache : [{ type: 'claude-code', label: 'claude-code' }];
}

// A list of identical rows (models, rate cards, env) with ✕ per row and an
// add button. `columns` describe the inputs; `read()` returns one object per
// row plus any `extra` the row was created with (used for masked secrets).
function rowList({ columns, rows, addLabel, blank }) {
  const list = el('div', { class: 'row-list' });
  const addRow = (values = {}, extra = {}) => {
    const row = el('div', { class: 'row-list-row' });
    row._extra = extra;
    row._inputs = {};
    for (const c of columns) {
      let input;
      if (c.type === 'select') {
        input = el('select', { class: 'row-in', style: c.width ? `flex:0 0 ${c.width}` : null },
          c.options.map(([v, l]) => el('option', { value: v, selected: (values[c.key] ?? c.options[0][0]) === v ? '' : null }, l)));
      } else {
        input = el('input', {
          class: 'row-in', type: c.type || 'text', placeholder: c.placeholder || '',
          step: c.type === 'number' ? 'any' : null, min: c.type === 'number' ? '0' : null,
          style: c.width ? `flex:0 0 ${c.width}` : null,
          title: c.title || null,
        });
        input.value = values[c.key] ?? '';
      }
      if (c.onchange) input.addEventListener('change', () => c.onchange(row));
      row._inputs[c.key] = input;
      row.append(input);
    }
    row.append(el('button', { class: 'btn sm ghost', title: 'Remove', onclick: () => row.remove() }, '✕'));
    list.append(row);
    if (blank) blank(row);
    return row;
  };
  for (const r of rows) addRow(r.values || r, r.extra || {});
  const node = el('div', {},
    el('div', { class: 'row-list-head' }, columns.map((c) => el('span', { style: c.width ? `flex:0 0 ${c.width}` : null }, c.label))),
    list,
    el('button', { class: 'btn sm', style: 'margin-top:6px', onclick: () => { const r = addRow(); r._inputs[columns[0].key].focus(); } }, '+ ' + addLabel),
  );
  const read = () => [...list.children].map((row) => {
    const out = { ...row._extra };
    for (const c of columns) out[c.key] = row._inputs[c.key].value.trim();
    return out;
  });
  return { node, read };
}

// Register (agent = null) or edit (agent = registered agent). Everything the
// registry holds is here: identity, models, billing, env. Saved with the
// existing POST / PUT; the server normalises pricing and keeps masked
// secrets, so this only has to assemble the shape.
async function openAgentForm(agent) {
  const types = await agentTypes();
  const editing = !!agent;
  const p = agent?.pricing || {};
  const liveCount = editing ? instancesOf(agent.id).length : 0;

  // Identity
  const nameIn = el('input', { placeholder: 'e.g. GLM 5.3' });
  nameIn.value = agent?.name || '';
  const typeSel = el('select', { disabled: liveCount ? '' : null, title: liveCount ? 'Close its instances before changing the type' : null },
    types.map((t) => el('option', { value: t.type, selected: (agent?.type || types[0].type) === t.type ? '' : null }, t.label)));
  const descIn = el('input', { placeholder: 'What this agent is for' });
  descIn.value = agent?.description || '';
  const accentIn = el('input', { type: 'color', class: 'accent-in' });
  accentIn.value = agent?.accent || ACCENT_PRESETS[state.agents.length % ACCENT_PRESETS.length];
  const swatches = el('div', { class: 'accent-swatches' },
    ACCENT_PRESETS.map((c) => el('button', {
      class: 'accent-swatch', style: `--agent-accent:${c}`, title: c, type: 'button',
      onclick: () => { accentIn.value = c; },
    })));

  // Models
  const models = rowList({
    columns: [
      { key: 'value', label: 'Value (passed to --model)', placeholder: 'glm-5.3' },
      { key: 'label', label: 'Label', placeholder: 'GLM 5.3' },
    ],
    rows: agent?.models || [],
    addLabel: 'Add model',
  });

  // Billing — subscription
  const planIn = el('input', { placeholder: 'e.g. Max plan, GLM Coding Plan' });
  planIn.value = p.plan || '';
  const amountIn = el('input', { type: 'number', step: 'any', min: '0', placeholder: '0' });
  amountIn.value = typeof p.amount === 'number' ? String(p.amount) : '';
  const currencyIn = el('input', { list: 'currency-list', maxlength: '3', placeholder: 'USD', class: 'currency-in' });
  currencyIn.value = p.currency || (typeof p.amount === 'number' ? 'USD' : '');
  const currencyList = el('datalist', { id: 'currency-list' }, ['USD', 'GBP', 'EUR'].map((c) => el('option', { value: c })));
  const periodSel = el('select', {},
    el('option', { value: 'month', selected: p.period !== 'year' ? '' : null }, 'per month'),
    el('option', { value: 'year', selected: p.period === 'year' ? '' : null }, 'per year'));
  const renewsIn = el('input', { type: 'date' });
  renewsIn.value = p.renewsOn || '';

  // Billing — rate card. A flat card is one row with a blank model; a map is
  // one row per model with 'default' shown as blank.
  const cardRows = [];
  if (isRateCard(p.perMillion)) cardRows.push({ model: '', ...p.perMillion });
  else if (p.perMillion) for (const [m, c] of Object.entries(p.perMillion)) cardRows.push({ model: m === 'default' ? '' : m, ...c });
  const rates = rowList({
    columns: [
      { key: 'model', label: 'Model (blank = default)', placeholder: 'default' },
      { key: 'input', label: 'Input', type: 'number', width: '80px' },
      { key: 'output', label: 'Output', type: 'number', width: '80px' },
      { key: 'cacheRead', label: 'Cache read', type: 'number', width: '80px' },
      { key: 'cacheWrite', label: 'Cache write', type: 'number', width: '80px' },
    ],
    rows: cardRows,
    addLabel: 'Add rate card',
  });

  // Env — value or file path per key; a masked secret keeps its stored value
  // unless something new is typed.
  const envRows = Object.entries(agent?.env || {}).map(([key, v]) => {
    if (v && typeof v === 'object' && v.file) return { values: { key, mode: 'file', value: v.file } };
    if (v && typeof v === 'object' && v.secret) return { values: { key, mode: 'value', value: '' }, extra: { secret: true } };
    return { values: { key, mode: 'value', value: String(v) } };
  });
  const env = rowList({
    columns: [
      { key: 'key', label: 'Variable', placeholder: 'ANTHROPIC_BASE_URL' },
      { key: 'mode', label: 'Kind', type: 'select', width: '90px', options: [['value', 'Value'], ['file', 'File']] },
      { key: 'value', label: 'Value or file path', placeholder: 'https://… or ~/.config/provider/token' },
    ],
    rows: envRows,
    addLabel: 'Add variable',
    blank: (row) => {
      if (row._extra.secret) {
        row._inputs.value.placeholder = '•••••• stored — leave blank to keep';
        row._inputs.value.title = 'The stored value is not shown; type to replace it';
      }
    },
  });

  function readBody() {
    const perMillion = {};
    for (const r of rates.read()) {
      const card = {};
      for (const k of RATE_KEYS) if (r[k] !== '') card[k] = Number(r[k]);
      if (Object.keys(card).length) perMillion[r.model || 'default'] = card;
    }
    const envOut = {};
    for (const r of env.read()) {
      if (!r.key) continue;
      if (r.mode === 'file') envOut[r.key] = { file: r.value };
      else if (r.value) envOut[r.key] = r.value;
      else if (r.secret) envOut[r.key] = { secret: true };
    }
    return {
      name: nameIn.value.trim(),
      type: typeSel.value,
      description: descIn.value.trim(),
      accent: accentIn.value,
      models: models.read().filter((m) => m.value),
      pricing: {
        plan: planIn.value.trim(),
        amount: amountIn.value === '' ? undefined : Number(amountIn.value),
        currency: currencyIn.value.trim().toUpperCase() || 'USD',
        period: periodSel.value,
        renewsOn: renewsIn.value || undefined,
        perMillion: Object.keys(perMillion).length ? perMillion : undefined,
      },
      env: envOut,
    };
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  async function save() {
    const body = readBody();
    if (!body.name) { toast('Give the agent a name', true); nameIn.focus(); return; }
    if (body.pricing.amount !== undefined && !body.pricing.plan) { toast('Name the plan the amount is for', true); planIn.focus(); return; }
    try {
      let saved;
      if (editing) {
        if (liveCount) delete body.type;
        saved = await api('/api/agents/' + encodeURIComponent(agent.id), { method: 'PUT', body });
        toast(`Saved ${saved.name}${liveCount ? ' — running instances pick it up on their next run' : ''}`);
      } else {
        saved = await api('/api/agents', { method: 'POST', body });
        toast(`Registered ${saved.name}`);
      }
      close();
      location.hash = '#/agent/' + encodeURIComponent(saved.id);
      if (editing && currentAgentId() === saved.id) renderAgentDetail(getAgent(saved.id) || saved);
    } catch (err) { toast(err.message, true); }
  }

  const section = (title, hint, ...kids) => el('div', { class: 'form-section' },
    el('h4', {}, title), hint ? el('div', { class: 'hint' }, hint) : null, ...kids);
  const field = (label, input, extra) => el('div', { class: 'field' }, el('label', {}, label), input, extra || null);

  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  },
    el('div', { class: 'modal modal-form modal-wide' },
      el('div', { class: 'modal-head' },
        el('strong', {}, editing ? `Edit ${agent.name}` : 'Register agent'),
        el('button', { class: 'btn sm modal-close', onclick: close }, '✕'),
      ),
      el('div', { class: 'modal-body' },
        section('Identity', null,
          el('div', { class: 'form-grid' },
            field('Name', nameIn),
            field('Type', typeSel),
            field('Description', descIn),
            field('Accent', el('div', { class: 'accent-row' }, accentIn, swatches)),
          ),
        ),
        section('Models', 'Options for the instance model dropdown; values go to the CLI (claude --model). Leave empty for the adapter\'s defaults.',
          models.node),
        section('Billing', 'A subscription means runs bill $0. A rate card (USD per million tokens) is what runs cost when there is no subscription; with one it only feeds the "≈$ list" estimate. Blank model = the default card.',
          el('div', { class: 'form-grid' },
            field('Plan', planIn),
            field('Cost', el('div', { class: 'money-row' }, amountIn, currencyIn, currencyList, periodSel)),
            field('Renews on', renewsIn, el('div', { class: 'hint' }, 'Reminder the day before via Telegram/email; rolls forward one period once it passes.')),
          ),
          el('div', { class: 'hint', style: 'margin:10px 0 6px' }, 'Rate card'),
          rates.node,
        ),
        section('Environment', 'Extra environment for the spawned CLI. Keep tokens out of Mission Control: put the secret in a file (e.g. ~/.config/zai/token) and choose File — the path is stored, never the token. Values under secret-looking keys are masked here.',
          env.node),
        editing ? el('div', { class: 'hint', style: 'margin-top:12px' },
          'Changes reach existing instances on their next run; a pricing change re-prices stored results.') : null,
      ),
      el('div', { class: 'modal-foot' },
        el('span', { class: 'kb-spacer' }),
        el('button', { class: 'btn', onclick: close }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: save }, editing ? 'Save' : 'Register'),
      ),
    ),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  nameIn.focus();
}

/* ── Home / overview ─────────────────────────────────────────────── */

function renderHome() {
  const working = state.instances.filter((i) => i.status?.state === 'working').length;
  const cost = state.instances.reduce((s, i) => s + (i.status?.totals?.cost || 0), 0);
  const est = state.instances.reduce((s, i) => s + (i.status?.totals?.estimated ?? i.status?.totals?.cost ?? 0), 0);

  main.replaceChildren(
    el('div', { class: 'page' },
      el('div', { class: 'home-head' },
        el('div', {},
          el('h1', { class: 'page-title' }, 'MISSION CONTROL'),
          el('p', { class: 'page-sub' }, 'Registered agents and the instances running under each.'),
        ),
        el('button', { class: 'btn primary sm', onclick: () => openAgentLauncher() }, '▶ Launch instance'),
      ),
      el('div', { class: 'stats' },
        statTile(state.agents.length, 'Agents registered'),
        statTile(state.instances.length, 'Instances', state.instances.length ? 'var(--green)' : null),
        statTile(working, 'Working', working > 0 ? 'var(--amber)' : null),
        el('div', { class: 'stat' },
          el('div', {
            class: 'stat-value', id: 'cli-live-count',
            style: cliOpenCount() ? 'color:var(--green)' : null,
          }, String(cliOpenCount())),
          el('div', { class: 'stat-label' }, 'CLI tabs open'),
        ),
        statTile(fmtCost(cost, est), 'Instance spend'),
      ),
      el('div', { class: 'panel cli-live-panel' },
        el('h3', {}, 'Live CLI sessions'),
        el('div', { id: 'cli-live-list' }, cliLiveRows()),
      ),
      el('div', { class: 'agent-grid' },
        state.agents.map(agentCard),
        el('button', { class: 'agent-card add-card', onclick: () => openAgentForm(null) },
          el('span', { class: 'add-card-plus' }, '+'),
          el('span', {}, 'Register agent'),
        ),
      ),
    )
  );
  refreshCliSessions();
}

// External CLI tabs (any terminal running Claude Code on this machine).
// Pulsing dot = transcript written in the last 2 minutes; steady green =
// tab open but quiet; grey = recent activity from a tab that has closed.
function cliOpenCount() {
  return state.cliSessions.filter((s) => s.open).length;
}

function cliLiveRows() {
  if (!state.cliSessions.length) {
    return [el('div', { class: 'cli-live-empty' },
      'No terminal Claude Code sessions detected.')];
  }
  return state.cliSessions.map((s) => {
    const fresh = s.mtime && Date.now() - s.mtime < 2 * 60 * 1000;
    const dot = fresh ? 'working' : s.open ? 'online' : 'offline';
    const folder = s.cwd ? (s.cwd.split('/').filter(Boolean).pop() || s.cwd) : '(unknown folder)';
    return el('div', { class: 'cli-live-row', title: s.cwd || '' },
      el('span', { class: 'dot ' + dot }),
      el('span', { class: 'cli-live-folder' }, folder),
      s.model ? el('span', { class: 'cli-live-chip' }, s.model) : null,
      s.branch ? el('span', { class: 'cli-live-chip' }, '⎇ ' + s.branch) : null,
      el('span', { class: 'cli-live-title' }, s.title || ''),
      !s.open ? el('span', { class: 'cli-live-chip' }, 'closed') : null,
      el('span', { class: 'cli-live-ago' }, s.mtime ? fmtAgo(s.mtime) : 'idle'),
    );
  });
}

async function refreshCliSessions() {
  if (Date.now() - state.cliFetchedAt < 5000) return;
  state.cliFetchedAt = Date.now();
  let data;
  try { data = await api('/api/cli-sessions'); } catch { return; }
  state.cliSessions = data.sessions || [];
  const list = $('#cli-live-list');
  if (list) list.replaceChildren(...cliLiveRows());
  const count = $('#cli-live-count');
  if (count) {
    count.textContent = String(cliOpenCount());
    count.style.color = cliOpenCount() ? 'var(--green)' : '';
  }
}

/* ── Run origin + duration estimate ──────────────────────────────── */

// Human label for where a run came from: chat, a board card, or the queue
// (which remembers what fed it).
function originLabel(origin) {
  if (!origin || !origin.kind) return null;
  const card = origin.taskTitle ? ' · ' + origin.taskTitle : '';
  if (origin.kind === 'chat') return '💬 chat';
  if (origin.kind === 'board') return '⌗ board' + card;
  if (origin.kind === 'queue') {
    const via = origin.via === 'board' ? '⌗ board' + card : '💬 chat';
    return '⧗ queue ← ' + via;
  }
  return origin.kind;
}

function originChip(origin, extraClass = '') {
  const label = originLabel(origin);
  if (!label) return null;
  return el('span', {
    class: 'origin-chip ' + (origin.kind || '') + (extraClass ? ' ' + extraClass : ''),
    title: 'Started from ' + label.replace(/^[^\w]+/, ''),
  }, label);
}

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

// Elapsed vs. estimate for an in-flight run. Purely informational — nothing
// reacts when a run overshoots except the wording.
function runClockText(startedAt, estimateMs) {
  const elapsed = Date.now() - startedAt;
  if (!estimateMs) return fmtClock(elapsed) + ' · no estimate yet';
  if (elapsed <= estimateMs) return fmtClock(elapsed) + ' · ~' + fmtClock(estimateMs - elapsed) + ' left';
  return fmtClock(elapsed) + ' · ' + fmtClock(elapsed - estimateMs) + ' over';
}

function runClock(run, extraClass = '') {
  if (!run || !run.startedAt) return null;
  const basis = run.estimateMs
    ? `Estimate: median of ${run.estimateSamples} past run${run.estimateSamples === 1 ? '' : 's'} (${run.estimateBasis})` +
      (run.toolCalls ? `, refined over ${run.toolCalls} tool calls` : '')
    : 'No completed runs to estimate from yet';
  const node = el('span', {
    class: 'run-clock' + (extraClass ? ' ' + extraClass : ''),
    'data-started': String(run.startedAt),
    'data-estimate': String(run.estimateMs || ''),
    title: basis,
  }, runClockText(run.startedAt, run.estimateMs || 0));
  tickRunClock(node);
  return node;
}

function tickRunClock(node) {
  const started = +node.dataset.started;
  const est = +node.dataset.estimate || 0;
  node.textContent = runClockText(started, est);
  node.classList.toggle('over', est > 0 && Date.now() - started > est);
}

function tickRunClocks() {
  document.querySelectorAll('.run-clock[data-started]').forEach(tickRunClock);
}
setInterval(tickRunClocks, 1000);

function statTile(value, label, color) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-value', style: color ? `color:${color}` : null }, String(value)),
    el('div', { class: 'stat-label' }, label),
  );
}

// One card per registered agent, its instances grouped inside: each row is a
// live session with its project, state, run clock, queue and cost.
function agentCard(agent) {
  const kids = instancesOf(agent.id);
  const stateName = !agent.available ? 'offline' : kids.some((i) => i.status?.state === 'working') ? 'working' : 'online';
  return el('div', {
    class: 'agent-card agent-card-group',
    style: `--card-accent:${agent.accent || 'var(--accent)'}`,
  },
    el('a', { class: 'agent-card-head', href: `#/agent/${encodeURIComponent(agent.id)}` },
      el('span', { class: `dot ${stateName}` }),
      el('span', { class: 'agent-card-name' }, agent.name),
      el('span', { class: `state-badge ${stateName}` }, agent.available ? `${kids.length} instance${kids.length === 1 ? '' : 's'}` : 'unavailable'),
    ),
    el('div', { class: 'agent-card-desc' }, agent.description || ''),
    kids.length
      ? el('div', { class: 'instance-list' }, kids.map(instanceRow))
      : el('div', { class: 'agent-card-task idle' }, agent.available ? 'no instances — ▶ to launch one' : 'CLI not found on this machine'),
    el('div', { class: 'btn-row agent-card-foot' },
      el('button', {
        class: 'btn sm primary', disabled: agent.available ? null : '',
        onclick: () => openAgentLauncher(agent.id),
      }, '▶ Launch'),
      el('a', { class: 'btn sm', href: `#/agent/${encodeURIComponent(agent.id)}` }, 'Configure'),
    ),
  );
}

function instanceRow(i) {
  const st = i.status || {};
  const stateName = st.state || 'offline';
  return el('a', {
    class: 'instance-row',
    href: `#/instance/${encodeURIComponent(i.id)}`,
    title: i.name,
  },
    el('span', { class: `dot ${stateName}` }),
    el('span', { class: 'instance-row-main' },
      el('span', { class: 'instance-row-name' }, '▣ ' + projName(i.projectId)),
      el('span', { class: 'instance-row-task' + (st.currentTask ? '' : ' idle') },
        st.currentTask ? '▸ ' + st.currentTask : 'standing by'),
      st.run ? el('span', { class: 'agent-card-run' }, originChip(st.run.origin, 'sm'), runClock(st.run, 'sm')) : null,
    ),
    el('span', { class: 'instance-row-meta' },
      el('span', {}, modelLabel(st)),
      st.queue?.length ? el('span', { class: 'card-queue' }, `⧗ ${st.queue.length}`) : null,
      st.subagents?.length ? el('span', { class: 'card-queue' }, `⑂ ${st.subagents.length}`) : null,
      el('span', {}, fmtCost(st.totals?.cost, st.totals?.estimated)),
      el('span', {}, fmtAgo(st.lastActivity)),
    ),
  );
}

/* ── Projects page ───────────────────────────────────────────────── */

function renderProjects() {
  const list = el('div', { class: 'proj-list' });
  main.replaceChildren(
    el('div', { class: 'page' },
      el('h1', { class: 'page-title' }, 'PROJECTS'),
      el('p', { class: 'page-sub' },
        'Each project is a root folder with its own context, agent files, and memory. Point an agent at one from its header to work in it.'),
      list,
      el('div', { class: 'proj-list' }, projectForm(null)),
    )
  );
  for (const p of state.projects) list.append(projectCard(p));
  if (!state.projects.length) {
    list.append(el('p', { class: 'page-sub' }, 'No projects registered yet — add one below.'));
  }
  // Fill in local Claude Code history counts asynchronously.
  for (const p of state.projects) {
    api(`/api/projects/${p.id}/claude-sessions`).then((data) => {
      const line = $('#chist-' + CSS.escape(p.id));
      if (!line) return;
      const own = data.sessions.length;
      const parent = data.parentSessions?.length || 0;
      if (!own && !parent) {
        line.textContent = '🧠 no local Claude Code sessions for this folder';
      } else {
        const latest = Math.max(data.sessions[0]?.mtime || 0, data.parentSessions?.[0]?.mtime || 0);
        line.textContent = `🧠 ${own} local session${own === 1 ? '' : 's'}` +
          (parent ? ` (+${parent} from parent folders)` : '') +
          ` · last ${fmtAgo(latest)}`;
      }
    }).catch(() => {});
  }
}

function projectCard(p) {
  if (state.projEdit === p.id) return projectForm(p);
  const live = state.instances.filter((i) => i.projectId === p.id);
  return el('div', { class: 'panel proj-card' },
    el('div', { class: 'proj-head' },
      el('strong', {}, p.name),
      el('span', { class: 'proj-path' }, p.path),
    ),
    p.description ? el('div', { class: 'proj-desc' }, p.description) : null,
    el('div', { class: 'proj-agents' },
      live.length
        ? '⚡ ' + live.map((i) => `${i.agent}${i.status?.state === 'working' ? ' (working)' : ''}`).join(', ') + ' running here'
        : 'no instances running here'),
    el('div', { class: 'proj-agents chist-line', id: 'chist-' + p.id }, '🧠 checking local Claude Code history…'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn sm', onclick: () => { location.hash = '#/project/' + encodeURIComponent(p.id); } }, '🗂 Conversations'),
      el('button', { class: 'btn sm', onclick: () => { state.projEdit = p.id; renderProjects(); } }, 'Edit'),
      el('button', {
        class: 'btn sm danger',
        onclick: async () => {
          if (!confirm(`Remove project "${p.name}" from Mission Control?\n(Files on disk are not touched.)`)) return;
          try {
            await api('/api/projects/' + p.id, { method: 'DELETE' });
            toast('Project removed');
          } catch (err) { toast(err.message, true); }
        },
      }, 'Remove'),
    ),
  );
}

function projectForm(p) {
  const nameIn = el('input', { placeholder: 'Project name', value: p?.name || '' });
  const pathIn = el('input', { placeholder: '/absolute/path/to/project  (or ~/…)', value: p?.path || '' });
  const descIn = el('input', { placeholder: 'Description (optional)', value: p?.description || '' });
  return el('div', { class: 'panel proj-card' },
    el('h3', {}, p ? 'Edit project' : 'Register project'),
    el('div', { class: 'field' }, el('label', {}, 'Name'), nameIn),
    el('div', { class: 'field' },
      el('label', {}, 'Root folder'),
      el('div', { class: 'path-row' },
        pathIn,
        el('button', {
          class: 'btn',
          onclick: () => openFolderPicker(pathIn.value, (chosen) => { pathIn.value = chosen; }),
        }, 'Browse…'),
      ),
    ),
    el('div', { class: 'field' }, el('label', {}, 'Description'), descIn),
    el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn primary sm',
        onclick: async () => {
          try {
            const body = { name: nameIn.value, path: pathIn.value, description: descIn.value };
            if (p) await api('/api/projects/' + p.id, { method: 'PUT', body });
            else await api('/api/projects', { method: 'POST', body });
            state.projEdit = null;
            toast(p ? 'Project updated' : 'Project registered');
          } catch (err) { toast(err.message, true); }
        },
      }, p ? 'Save' : 'Add project'),
      p ? el('button', { class: 'btn sm', onclick: () => { state.projEdit = null; renderProjects(); } }, 'Cancel') : null,
    ),
  );
}

/* ── Analytics page ──────────────────────────────────────────────── */

function fmtDur(ms) {
  if (!ms) return '—';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(0) + 's';
  return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

// Actual spend, plus what the same tokens would cost at list price when the
// two differ (subscription-backed agents with a rate card configured).
function fmtCost(cost, est, digits = 3) {
  const actual = '$' + (cost || 0).toFixed(digits);
  return typeof est === 'number' && Math.abs(est - (cost || 0)) > 1e-9
    ? `${actual} (≈$${est.toFixed(digits)} list)`
    : actual;
}

function fmtFeedTime(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function hbar(name, value, max, fmt) {
  return el('div', { class: 'hbar-row' },
    el('span', { class: 'hbar-name', title: name }, name),
    el('div', { class: 'hbar-track' },
      el('div', { class: 'hbar-fill', style: `width:${max ? Math.max(2, (value / max) * 100) : 0}%` })),
    el('span', { class: 'hbar-val' }, fmt(value)),
  );
}

async function renderAnalytics() {
  if (!onAnalyticsPage()) return;
  let data, feed;
  try {
    [data, feed] = await Promise.all([api('/api/analytics'), api('/api/feed?limit=60')]);
  } catch (err) {
    main.replaceChildren(el('div', { class: 'page' }, el('p', { class: 'page-sub' }, err.message)));
    return;
  }
  const t = data.totals;

  // Subscription-backed agents bill $0 per run, so bars and rankings use the
  // list-price estimate (which equals actual spend for metered agents) and
  // labels show both figures when they differ.
  const hasEstimates = data.agents.some((a) => Math.abs(a.estimated - a.cost) > 1e-9);

  // Cost-by-day bars
  const maxDay = Math.max(...data.days.map((d) => d.estimated), 0.0001);
  const chart = el('div', { class: 'an-chart' },
    data.days.map((d) => {
      const breakdown = Object.entries(d.byAgent).map(([n, c]) => `${n}: ${fmtCost(c.cost, c.estimated)}`).join('\n');
      return el('div', { class: 'an-bar-col', title: `${d.date}\n${fmtCost(d.cost, d.estimated)} · ${d.runs} runs${breakdown ? '\n' + breakdown : ''}` },
        el('div', { class: 'an-bar' + (d.estimated ? '' : ' empty'), style: `height:${Math.max(2, (d.estimated / maxDay) * 100)}%` }),
        el('span', { class: 'an-bar-label' }, d.date.slice(8)),
      );
    })
  );

  // Subscriptions (M15): flat-rate plans as a real line item next to the
  // per-run figures — monthly equivalent per currency, renewal countdown.
  const subs = data.subscriptions || [];
  const subTotals = {};
  for (const s of subs) if (typeof s.monthlyEquivalent === 'number') subTotals[s.currency] = (subTotals[s.currency] || 0) + s.monthlyEquivalent;
  const subTotalText = Object.keys(subTotals).length
    ? Object.entries(subTotals).map(([c, v]) => fmtMoney(Math.round(v * 100) / 100, c)).join(' + ') : '—';
  const subRows = subs.map((s) => {
    const days = s.daysToRenewal;
    const rel = days === null ? '—' : days < 0 ? `${-days}d overdue` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    const color = days === null ? '' : days < 0 ? 'color:var(--red)' : days <= 7 ? 'color:var(--amber)' : '';
    return el('tr', {},
      el('td', {}, el('a', { href: '#/agent/' + encodeURIComponent(s.agentId) }, s.name)),
      el('td', {}, s.plan),
      el('td', {}, typeof s.amount === 'number' ? `${fmtMoney(s.amount, s.currency)}/${s.period === 'year' ? 'yr' : 'mo'}` : '—'),
      el('td', {}, typeof s.monthlyEquivalent === 'number' ? fmtMoney(Math.round(s.monthlyEquivalent * 100) / 100, s.currency) : '—'),
      el('td', { style: color }, s.renewsOn ? `${s.renewsOn} · ${rel}` : '—'),
    );
  });

  const agentsSorted = [...data.agents].sort((a, b) => b.estimated - a.estimated);
  const projSorted = [...data.projects].sort((a, b) => b.estimated - a.estimated);
  const maxAgentCost = Math.max(...agentsSorted.map((a) => a.estimated), 0.0001);
  const maxProjCost = Math.max(...projSorted.map((p) => p.estimated), 0.0001);

  const outcomesRows = data.agents.map((a) =>
    el('tr', {},
      el('td', {}, a.name),
      el('td', {}, String(a.runs)),
      el('td', { style: a.failures ? 'color:var(--red)' : '' }, String(a.failures)),
      el('td', {}, a.runs ? Math.round(((a.runs - a.failures) / a.runs) * 100) + '%' : '—'),
      el('td', {}, fmtDur(a.avgMs)),
      el('td', {}, fmtDur(a.maxMs)),
      el('td', {}, fmtTokens(a.tokensIn) + ' / ' + fmtTokens(a.tokensOut)),
      el('td', {}, fmtCost(a.cost, a.estimated)),
    ));

  const healthCards = data.projects.map((p) => {
    const open = p.openTasks;
    const cardBits = ['backlog', 'inprogress', 'review'].map((c) => open[c] ? `${open[c]} ${c === 'inprogress' ? 'in progress' : c}` : null).filter(Boolean);
    return el('div', { class: 'panel health-card' },
      el('div', { class: 'proj-head' },
        el('strong', {}, p.name),
        p.git && !p.git.notRepo
          ? el('span', { class: 'proj-path' }, `⎇ ${p.git.branch || '?'}${p.git.dirty ? ` · ${p.git.dirty} uncommitted` : ' · clean'}`)
          : p.git?.notRepo ? el('span', { class: 'proj-path' }, 'no git repo') : null,
      ),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Runs / cost'), el('span', { class: 'v' }, `${p.runs} · ${fmtCost(p.cost, p.estimated)}`)),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Open cards'), el('span', { class: 'v' }, cardBits.length ? cardBits.join(', ') : 'none')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Agents here'), el('span', { class: 'v' }, p.agents.length ? p.agents.join(', ') : '—')),
      el('div', { class: 'kv' }, el('span', { class: 'k' }, 'Last activity'), el('span', { class: 'v' }, fmtAgo(p.lastActivity))),
    );
  });

  const FEED_ICONS = { start: ['▶', 'var(--accent)'], done: ['✓', 'var(--green)'], fail: ['✗', 'var(--red)'], error: ['!', 'var(--red)'], meta: ['·', 'var(--text-faint)'] };
  const feedItems = feed.map((item) => {
    const [icon, color] = FEED_ICONS[item.kind] || ['·', 'var(--text-dim)'];
    let text = '';
    if (item.kind === 'start') {
      const from = item.origin && item.origin.kind !== 'chat' ? ` from ${originLabel(item.origin)}` : '';
      text = `started${from}: ` + item.text;
    }
    else if (item.kind === 'done') text = `finished${item.durationMs ? ' in ' + fmtDur(item.durationMs) : ''}${typeof item.cost === 'number' ? ' · ' + fmtCost(item.cost, item.estimated) : ''}`;
    else if (item.kind === 'fail') text = 'run failed';
    else text = item.text || '';
    // A live instance opens its Control Room; a closed one opens the
    // conversation in the project's history.
    const open = () => {
      if (item.iid && getInstance(item.iid)) location.hash = '#/instance/' + encodeURIComponent(item.iid);
      else if (item.pid) location.hash = '#/project/' + encodeURIComponent(item.pid) + (item.cid ? '/' + encodeURIComponent(item.cid) : '');
    };
    return el('div', { class: 'feed-item', onclick: open },
      el('span', { class: 'feed-time' }, fmtFeedTime(item.ts)),
      el('span', { class: 'feed-ic', style: `color:${color}` }, icon),
      el('span', { class: 'feed-text' },
        el('b', {}, item.instance || item.agent), ' ', text,
        item.pid ? el('span', { class: 'feed-proj' }, ' ▣ ' + projName(item.pid)) : null,
      ),
    );
  });

  main.replaceChildren(
    el('div', { class: 'page' },
      el('h1', { class: 'page-title' }, 'ANALYTICS'),
      el('p', { class: 'page-sub' }, 'Cost, outcomes, and activity across the fleet (from the retained event history).'),
      el('div', { class: 'stats' },
        statTile('$' + t.todayCost.toFixed(2), 'Spend today' + (Math.abs(t.todayEstimated - t.todayCost) > 1e-9 ? ` · ≈$${t.todayEstimated.toFixed(2)} list` : '')),
        statTile('$' + t.weekCost.toFixed(2), 'Last 7 days' + (Math.abs(t.weekEstimated - t.weekCost) > 1e-9 ? ` · ≈$${t.weekEstimated.toFixed(2)} list` : '')),
        statTile(subTotalText, 'Subscriptions / month'),
        statTile(t.runs, 'Runs'),
        statTile(t.successRate === null ? '—' : Math.round(t.successRate * 100) + '%', 'Success rate',
          t.successRate !== null && t.successRate < 0.9 ? 'var(--amber)' : null),
        statTile(fmtDur(t.avgMs), 'Avg run'),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, 'Subscriptions'),
        subs.length
          ? el('div', { style: 'overflow-x:auto' },
              el('table', { class: 'an-table' },
                el('thead', {}, el('tr', {}, ['Agent', 'Plan', 'Cost', 'Per month', 'Renews'].map((h) => el('th', {}, h)))),
                el('tbody', {}, subRows)))
          : el('div', { class: 'hint' }, 'No flat-rate plans registered. Add one on an agent\'s page (Edit → Billing) to see it here and get a reminder the day before it renews.'),
      ),
      data.budget.threshold > 0 ? el('div', { class: 'panel budget-panel' },
        el('h3', {}, `Daily budget — $${data.budget.threshold.toFixed(2)}`),
        el('div', { class: 'budget-track' },
          el('div', {
            class: 'budget-fill' + (data.budget.todayCost >= data.budget.threshold ? ' over' : ''),
            style: `width:${Math.min(100, (data.budget.todayCost / data.budget.threshold) * 100)}%`,
          })),
        el('div', { class: 'hint' }, `$${data.budget.todayCost.toFixed(2)} spent today (${Math.round((data.budget.todayCost / data.budget.threshold) * 100)}%)`),
      ) : null,
      el('div', { class: 'panel' },
        el('h3', {}, 'Cost by day — last 14 days'),
        hasEstimates ? el('div', { class: 'hint' }, 'Subscription agents bill $0 per run; "≈$ list" is what their tokens would cost at the provider\'s list price, and bars are sized by it.') : null,
        chart),
      el('div', { class: 'control-grid', style: 'margin-top:16px' },
        el('div', { class: 'panel' },
          el('h3', {}, 'Cost by agent'),
          agentsSorted.map((a) => hbar(a.name, a.estimated, maxAgentCost, () => fmtCost(a.cost, a.estimated)))),
        el('div', { class: 'panel' },
          el('h3', {}, 'Cost by project'),
          projSorted.map((p) => hbar(p.name, p.estimated, maxProjCost, () => fmtCost(p.cost, p.estimated)))),
        el('div', { class: 'panel span2' },
          el('h3', {}, 'Run outcomes'),
          el('div', { style: 'overflow-x:auto' },
            el('table', { class: 'an-table' },
              el('tr', {},
                ...['Agent', 'Runs', 'Failures', 'Success', 'Avg', 'Longest', 'Tokens in/out', 'Cost'].map((h) => el('th', {}, h))),
              outcomesRows)),
        ),
        el('div', { class: 'panel span2' },
          el('h3', {}, 'Project health'),
          el('div', { class: 'health-grid' }, healthCards)),
        el('div', { class: 'panel span2' },
          el('h3', {}, 'Activity feed'),
          el('div', { class: 'feed-list' }, feedItems.length ? feedItems : el('div', { class: 'hint' }, 'No activity yet'))),
      ),
    )
  );
}

/* ── Alerts page ─────────────────────────────────────────────────── */

async function renderAlerts() {
  let cfg;
  try {
    cfg = await api('/api/notifications');
  } catch (err) {
    main.replaceChildren(el('div', { class: 'page' }, el('p', { class: 'page-sub' }, err.message)));
    return;
  }

  const field = (label, input) => el('div', { class: 'field' }, el('label', {}, label), input);
  const checkRow = (label, checked) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = !!checked;
    return { box, row: el('label', { class: 'check-row' }, box, label) };
  };
  const textIn = (value, placeholder, type = 'text') => {
    const input = el('input', { type, placeholder });
    input.value = value ?? '';
    return input;
  };

  // Telegram
  const tgOn = checkRow('Enable Telegram alerts', cfg.telegram.enabled);
  const tgToken = textIn(cfg.telegram.botToken, 'Bot token from @BotFather', 'password');
  const tgChat = textIn(cfg.telegram.chatId, 'Chat ID (use Detect)');

  // Email
  const emOn = checkRow('Enable daily email digest', cfg.email.enabled);
  const emHost = textIn(cfg.email.smtpHost, 'smtp.example.com');
  const emPort = textIn(cfg.email.smtpPort, '587');
  const emSecure = checkRow('TLS from the start (port 465)', cfg.email.smtpSecure);
  const emUser = textIn(cfg.email.smtpUser, 'SMTP username');
  const emPass = textIn(cfg.email.smtpPass, 'SMTP password / app password', 'password');
  const emFrom = textIn(cfg.email.from, 'mission-control@yourdomain (optional)');
  const emTo = textIn(cfg.email.to, 'you@example.com');
  const emHour = el('select', {},
    ...Array.from({ length: 24 }, (_, h) =>
      el('option', { value: String(h), selected: +cfg.email.digestHour === h ? '' : null }, `${String(h).padStart(2, '0')}:00`)));

  // Events
  const evDone = checkRow('Run completed', cfg.events.runComplete);
  const evFail = checkRow('Run failed / errored', cfg.events.runFailed);
  const evOff = checkRow('Agent went offline', cfg.events.agentOffline);
  const evRenew = checkRow('Subscription renews tomorrow', cfg.events.renewalReminder !== false);
  const evCost = textIn(cfg.events.costThreshold || '', '0 = off');

  async function save(quiet) {
    const body = {
      telegram: { enabled: tgOn.box.checked, botToken: tgToken.value.trim(), chatId: tgChat.value.trim() },
      email: {
        enabled: emOn.box.checked,
        smtpHost: emHost.value.trim(),
        smtpPort: +emPort.value || 587,
        smtpSecure: emSecure.box.checked,
        smtpUser: emUser.value.trim(),
        smtpPass: emPass.value,
        from: emFrom.value.trim(),
        to: emTo.value.trim(),
        digestHour: +emHour.value,
      },
      events: {
        runComplete: evDone.box.checked,
        runFailed: evFail.box.checked,
        agentOffline: evOff.box.checked,
        renewalReminder: evRenew.box.checked,
        costThreshold: +evCost.value || 0,
      },
    };
    await api('/api/notifications', { method: 'PUT', body });
    if (!quiet) toast('Alert settings saved');
  }
  const trySave = (quiet) => save(quiet).catch((err) => { toast(err.message, true); throw err; });

  const testBtn = (label, action) => el('button', {
    class: 'btn sm',
    onclick: async () => {
      try {
        await trySave(true);
        await action();
      } catch (err) {
        if (err) toast(err.message, true);
      }
    },
  }, label);

  main.replaceChildren(
    el('div', { class: 'page' },
      el('h1', { class: 'page-title' }, 'ALERTS'),
      el('p', { class: 'page-sub' }, 'Get pinged when agents finish, fail, or go quiet — even when you\'re away from the console.'),
      el('div', { class: 'control-grid', style: 'max-width:1000px' },
        el('div', { class: 'panel' },
          el('h3', {}, 'Telegram — instant alerts'),
          tgOn.row,
          field('Bot token', tgToken),
          el('div', { class: 'field' },
            el('label', {}, 'Chat ID'),
            el('div', { class: 'path-row' },
              tgChat,
              el('button', {
                class: 'btn',
                onclick: async () => {
                  try {
                    await trySave(true);
                    const r = await api('/api/notifications/telegram/detect-chat', { method: 'POST', body: {} });
                    tgChat.value = r.chatId;
                    toast(`Chat detected${r.name ? ': ' + r.name : ''}`);
                  } catch (err) { if (err?.message) toast(err.message, true); }
                },
              }, 'Detect'),
            ),
          ),
          el('p', { class: 'hint' }, '1. Create a bot with @BotFather and paste its token. 2. Send your bot any message. 3. Click Detect.'),
          testBtn('Send test message', async () => {
            await api('/api/notifications/test', { method: 'POST', body: { channel: 'telegram' } });
            toast('Test message sent ✓');
          }),
        ),
        el('div', { class: 'panel' },
          el('h3', {}, 'Email — daily digest'),
          emOn.row,
          field('SMTP host', emHost),
          el('div', { class: 'two-col' }, field('Port', emPort), el('div', { class: 'field' }, el('label', {}, ' '), emSecure.row)),
          field('Username', emUser),
          field('Password', emPass),
          field('From', emFrom),
          field('To', emTo),
          field('Send digest at', emHour),
          el('div', { class: 'btn-row' },
            testBtn('Send test email', async () => {
              await api('/api/notifications/test', { method: 'POST', body: { channel: 'email' } });
              toast('Test email sent ✓');
            }),
            testBtn('Send digest now', async () => {
              await api('/api/notifications/digest/send', { method: 'POST', body: {} });
              toast('Digest sent ✓');
            }),
          ),
        ),
        el('div', { class: 'panel span2' },
          el('h3', {}, 'What to notify about'),
          el('div', { class: 'check-grid' }, evDone.row, evFail.row, evOff.row, evRenew.row),
          field('Daily cost alert threshold ($)', evCost),
          el('button', { class: 'btn primary', onclick: () => trySave(false).catch(() => {}) }, 'Save settings'),
        ),
      ),
    )
  );
}

/* ── Vault page (M14) ────────────────────────────────────────────── */

// The Vault page browses the shared fleet vault: a file tree with
// needs-review flags, a note viewer/editor, full-text search, and the write
// activity feed (the vault's git log) with one-click revert of a single
// write. Writes also arrive from MCP servers in other processes, so the tree
// and feed are polled while the page is visible — nothing pushes to us.

function vaultState() {
  return (state.vault ||= {
    sel: null,          // open note path (null = nothing open)
    isNew: false,       // editor holds a not-yet-created note
    draft: '',          // editor content, kept across re-renders while open
    q: '',              // search query — '' shows the plain tree
    flaggedOnly: false, // tree filtered to needs-review notes
    expanded: new Set(['_catalog', '_mc', 'notes']),
  });
}

async function renderVault() {
  let status = null;
  let statusErr = null;
  try { status = await api('/api/vault'); } catch (err) { statusErr = err; }
  if (!status || !status.enabled) return renderVaultDisabled(status, statusErr);
  if (!status.ready) {
    main.replaceChildren(el('div', { class: 'page' },
      el('h1', { class: 'page-title' }, 'VAULT'),
      el('p', { class: 'page-sub' }, `Vault is initializing at ${status.path || '…'} — hang on, this page catches it automatically.`),
      el('div', { class: 'panel', id: 'vault-retry' }, el('span', { class: 'hint' }, 'initializing…')),
    ));
    return;
  }

  const v = vaultState();
  const searchIn = el('input', {
    type: 'search', placeholder: 'Search the vault…', value: v.q,
    style: 'width:100%',
  });
  let searchTimer = null;
  searchIn.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { v.q = searchIn.value.trim(); refreshVaultTree(); }, 250);
  });
  searchIn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchIn.value = ''; v.q = ''; refreshVaultTree(); }
  });

  const treeList = el('div', { class: 'vault-tree-list', id: 'vault-tree-list' });
  const notePane = el('div', { class: 'panel vault-note', id: 'vault-note-pane' });
  const feedList = el('div', { class: 'vault-feed-list', id: 'vault-feed-list' });

  const flagBtn = el('button', {
    class: 'btn sm' + (v.flaggedOnly ? ' primary' : ''),
    title: 'Show only notes flagged needs-review',
    onclick: () => { v.flaggedOnly = !v.flaggedOnly; renderVault(); },
  }, '⚑ Needs review');

  main.replaceChildren(
    el('div', { class: 'page vault-page' },
      el('div', { class: 'vault-head' },
        el('h1', { class: 'page-title', style: 'margin:0' }, 'VAULT'),
        el('span', { class: 'vault-path', title: status.path }, status.path),
        status.stats ? el('span', { class: 'vault-stats' },
          `${status.stats.notes} notes · ${status.stats.catalog} catalog · ${status.stats.mc} mc`) : null,
        el('span', { class: 'flex-spacer' }),
        flagBtn,
        el('button', { class: 'btn sm', title: 'Refresh', onclick: () => { refreshVaultTree(); refreshVaultFeed(); } }, '↻'),
      ),
      el('div', { class: 'vault-body' },
        el('div', { class: 'panel vault-tree' },
          el('div', { class: 'vault-tree-head' }, searchIn),
          treeList,
          el('div', { class: 'vault-tree-foot' },
            el('button', {
              class: 'btn sm', title: 'New note (bare names land in notes/)',
              onclick: newVaultNote,
            }, '+ New note')),
        ),
        notePane,
        el('div', { class: 'panel vault-feed' },
          el('h3', { style: 'margin:0 0 4px' }, 'Write activity'),
          el('div', { class: 'hint', style: 'margin-bottom:6px' }, 'Every vault write, newest first — ▤ the diff, ↩ to revert one.'),
          feedList,
        ),
      ),
    )
  );

  await Promise.all([refreshVaultTree(), refreshVaultFeed()]);
  if (v.sel && !v.isNew) openVaultNote(v.sel);
  else if (v.isNew) renderVaultEditor(v.sel, v.draft, true);
  else showVaultNoteEmpty();
}

function renderVaultDisabled(status, statusErr) {
  main.replaceChildren(el('div', { class: 'page' },
    el('h1', { class: 'page-title' }, 'VAULT'),
    el('p', { class: 'page-sub' },
      statusErr
        ? `Could not reach the vault status endpoint: ${statusErr.message}`
        : 'The shared fleet vault is disabled. Agents spawn without vault context and nothing reads or writes it.'),
    el('div', { class: 'panel', id: 'vault-retry' },
      el('h3', {}, statusErr ? 'Vault unreachable' : 'Vault disabled'),
      el('p', { class: 'hint' },
        `Path: ${status?.path || '(default: a fleet-vault folder next to mission control)'} — configure via data/settings.json \`_vault\` or PUT /api/vault.`),
      statusErr ? null : el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await api('/api/vault', { method: 'PUT', body: { enabled: true } });
              toast('Vault enabled');
              renderVault();
            } catch (err) { toast(err.message, true); }
          },
        }, 'Enable vault'),
      ),
    ),
  ));
}

/* ── Tree + search ───────────────────────────────────────────────── */

async function refreshVaultTree() {
  const box = $('#vault-tree-list');
  if (!box) return;
  const v = vaultState();
  if (v.q) return refreshVaultSearch(box, v);
  let entries;
  try {
    entries = await api('/api/vault/notes');
  } catch (err) {
    box.replaceChildren(el('div', { class: 'vault-tree-empty' }, err.message));
    return;
  }
  if (v.flaggedOnly) entries = entries.filter((e) => e.needsReview);

  // Group the flat index into nested folder rows. The vault is flat by
  // design (notes/, _catalog/, _mc/), but nesting costs nothing.
  const root = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const segs = e.path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], { name: segs[i], dirs: new Map(), files: [] });
      node = node.dirs.get(segs[i]);
    }
    node.files.push(e);
  }

  box.replaceChildren(...vaultTreeNodes(root, 0));
  if (!entries.length) {
    box.append(el('div', { class: 'vault-tree-empty' },
      v.flaggedOnly ? 'No notes flagged needs-review' : 'The vault is empty'));
  }
  markVaultTreeSelection();
}

function vaultTreeNodes(node, depth) {
  const v = vaultState();
  const rows = [];
  for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const all = [...dir.dirs.keys(), ...dir.files.map((f) => f.path)];
    const flagged = dir.files.filter((f) => f.needsReview).length;
    const open = v.expanded.has(dir.name);
    const children = el('div', { class: 'ftree-children', style: open ? '' : 'display:none' },
      open ? vaultTreeNodes(dir, depth + 1) : null);
    const caret = el('span', { class: 'ftree-caret' }, open ? '▾' : '▸');
    const row = el('div', {
      class: 'ftree-row dir', 'data-dir': dir.name,
      style: `padding-left:${8 + depth * 14}px`,
    },
      caret,
      el('span', { class: 'ftree-icon' }, '📁'),
      el('span', { class: 'name' }, dir.name + '/'),
      flagged ? el('span', { class: 'flag-badge', title: `${flagged} needs review` }, `⚑ ${flagged}`) : null,
      el('span', { class: 'size' }, String(all.length)),
    );
    row.addEventListener('click', () => {
      const nowOpen = !v.expanded.has(dir.name);
      if (nowOpen) v.expanded.add(dir.name); else v.expanded.delete(dir.name);
      caret.textContent = nowOpen ? '▾' : '▸';
      children.style.display = nowOpen ? '' : 'none';
      if (nowOpen && !children.childElementCount) children.append(...vaultTreeNodes(dir, depth + 1));
    });
    rows.push(el('div', { class: 'ftree-node' }, row, children));
  }
  const files = node.files.sort((a, b) => a.path.localeCompare(b.path));
  for (const f of files) {
    rows.push(el('div', {
      class: 'ftree-row' + (f.needsReview ? ' flagged' : '') + (f.path === v.sel ? ' selected' : ''),
      'data-path': f.path, title: f.path,
      style: `padding-left:${28 + depth * 14}px`,
      onclick: () => openVaultNote(f.path),
    },
      el('span', { class: 'ftree-icon' }, '📄'),
      el('span', { class: 'name' }, f.title),
      f.needsReview ? el('span', { class: 'flag-badge', title: 'needs review' }, '⚑') : null,
      f.updated ? el('span', { class: 'size' }, String(f.updated).slice(5)) : null,
    ));
  }
  return rows;
}

async function refreshVaultSearch(box, v) {
  let hits;
  try {
    hits = await api(`/api/vault/search?query=${encodeURIComponent(v.q)}&limit=30`);
  } catch (err) {
    box.replaceChildren(el('div', { class: 'vault-tree-empty' }, err.message));
    return;
  }
  box.replaceChildren(
    el('div', { class: 'vault-tree-empty' }, `${hits.length} match${hits.length === 1 ? '' : 'es'}`),
    ...hits.map((h) => el('div', {
      class: 'ftree-row vault-hit' + (h.path === v.sel ? ' selected' : ''),
      'data-path': h.path, title: h.path,
      onclick: () => openVaultNote(h.path),
    },
      el('span', { class: 'ftree-icon' }, h.needsReview ? '⚑' : '📄'),
      el('span', { class: 'vault-hit-text' },
        el('div', { class: 'vault-hit-title' }, h.title),
        el('div', { class: 'vault-hit-path' }, h.path),
        h.snippet ? el('div', { class: 'vault-hit-snip' }, '…' + h.snippet + '…') : null,
      ),
    )),
  );
  markVaultTreeSelection();
}

function markVaultTreeSelection() {
  const v = vaultState();
  for (const r of document.querySelectorAll('#vault-tree-list .ftree-row[data-path]')) {
    r.classList.toggle('selected', r.dataset.path === v.sel);
  }
}

/* ── Note viewer / editor ────────────────────────────────────────── */

function showVaultNoteEmpty() {
  const pane = $('#vault-note-pane');
  if (pane) pane.replaceChildren(el('div', { class: 'ws-empty' }, 'Select a note to view or edit'));
}

async function openVaultNote(rel) {
  const v = vaultState();
  v.sel = rel;
  v.isNew = false;
  markVaultTreeSelection();
  let note;
  try {
    note = await api(`/api/vault/note?path=${encodeURIComponent(rel)}`);
  } catch (err) {
    toast(err.message, true);
    showVaultNoteEmpty();
    return;
  }
  if (v.sel !== rel || !$('#vault-note-pane')) return; // user moved on mid-fetch
  renderVaultNote(note);
}

function renderVaultNote(note) {
  const pane = $('#vault-note-pane');
  if (!pane) return;
  const fm = note.fm || {};
  const flagged = fm['needs-review'] === true;
  const chips = [
    fm.type ? el('span', { class: 'fm-chip type' }, fm.type) : null,
    fm.project ? el('span', { class: 'fm-chip' }, '▣ ' + fm.project) : null,
    Array.isArray(fm.tags) && fm.tags.length ? el('span', { class: 'fm-chip' }, '# ' + fm.tags.join(' #')) : null,
    fm.author ? el('span', { class: 'fm-chip' }, '✎ ' + fm.author) : null,
    fm.updated ? el('span', { class: 'fm-chip' }, '⏱ ' + fm.updated) : null,
    flagged ? el('span', { class: 'fm-chip warn', title: 'Flagged needs-review' }, '⚑ needs review') : null,
  ];
  pane.replaceChildren(
    el('div', { class: 'vault-note-head' },
      el('span', { class: 'vault-note-path', title: note.path }, note.path),
      el('span', { class: 'flex-spacer' }),
      el('button', {
        class: 'btn sm' + (flagged ? ' primary' : ''),
        title: flagged ? 'Clear the needs-review flag' : 'Flag this note as stale / needs review',
        onclick: () => flagVaultNote(note, !flagged),
      }, flagged ? '✓ Clear flag' : '⚑ Flag'),
      el('button', {
        class: 'btn sm primary',
        onclick: () => {
          const v = vaultState();
          v.isNew = false;
          v.draft = note.text;
          renderVaultEditor(note.path, note.text, false);
        },
      }, '✎ Edit'),
    ),
    el('div', { class: 'fm-chips' }, chips),
    (() => {
      const md = el('div', { class: 'md' });
      md.innerHTML = renderNoteMarkdown(note.body); // el() children are text nodes; html goes through innerHTML
      return el('div', { class: 'vault-note-body' }, md);
    })(),
  );
}

// The editor works on the raw text, frontmatter included — write() parses and
// re-validates it server-side, exactly like an agent's vault_write.
function renderVaultEditor(rel, text, isNew) {
  const pane = $('#vault-note-pane');
  if (!pane) return;
  const v = vaultState();
  const ta = el('textarea', { spellcheck: 'false', class: 'vault-editor' });
  ta.value = text;
  // Keep the typed text in state so a re-render (flag toggle, poll of the
  // other panes, route away and back) restores exactly what was on screen.
  ta.addEventListener('input', () => { v.draft = ta.value; });
  pane.replaceChildren(
    el('div', { class: 'vault-note-head' },
      el('span', { class: 'vault-note-path', title: rel }, rel),
      el('span', { class: 'flex-spacer' }),
      el('button', {
        class: 'btn sm primary',
        onclick: async () => {
          try {
            const r = await api('/api/vault/note', { method: 'PUT', body: { path: rel, content: ta.value } });
            toast(`${r.created ? 'Created' : 'Saved'} ${r.path}${r.commit ? ` (${r.commit})` : ''}`);
            v.isNew = false;
            v.sel = r.path;
            await Promise.all([refreshVaultTree(), refreshVaultFeed()]);
            openVaultNote(r.path);
          } catch (err) { toast(err.message, true); }
        },
      }, 'Save'),
      el('button', {
        class: 'btn sm',
        onclick: () => {
          v.isNew = false;
          if (v.sel && v.sel !== rel) openVaultNote(v.sel);
          else if (isNew) { v.sel = null; showVaultNoteEmpty(); refreshVaultTree(); }
          else openVaultNote(rel);
        },
      }, 'Cancel'),
    ),
    isNew ? el('div', { class: 'hint', style: 'padding:0 14px 8px' },
      'notes/ require a type: project-note | convention | decision | gotcha | how-to') : null,
    ta,
  );
  ta.focus();
}

async function newVaultNote() {
  const rel = prompt('New note path (bare names land in notes/):', 'notes/new-note.md');
  if (!rel) return;
  const v = vaultState();
  v.sel = rel;
  v.isNew = true;
  v.draft = [
    '---',
    'type: how-to',
    'tags: []',
    '---',
    '',
    '# ' + rel.split('/').pop().replace(/\.md$/, '').replace(/[-_]+/g, ' '),
    '',
    '',
  ].join('\n');
  markVaultTreeSelection();
  renderVaultEditor(rel, v.draft, true);
}

async function flagVaultNote(note, flag) {
  try {
    await api('/api/vault/note', { method: 'PUT', body: { path: note.path, content: note.text, needsReview: flag } });
    toast(flag ? `Flagged ${note.path}` : `Cleared flag on ${note.path}`);
    await refreshVaultTree();
    openVaultNote(note.path);
  } catch (err) { toast(err.message, true); }
}

// Slightly fuller renderer than the chat one: vault notes carry headings,
// lists, links, and fences. Input is escaped before any transform.
function renderNoteMarkdown(text) {
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const blocks = (chunk) => {
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of escapeHtml(chunk).split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) { flushPara(); flushList(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push(`<${h[1].length <= 2 ? 'h3' : 'h4'}>${inline(h[2])}</${h[1].length <= 2 ? 'h3' : 'h4'}>`); continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        continue;
      }
      flushList();
      para.push(inline(line));
    }
    flushPara();
    flushList();
    return out.join('');
  };
  const parts = String(text || '').split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    html += blocks(parts[i] || '');
    if (i + 2 < parts.length) html += `<pre><code>${escapeHtml(parts[i + 2] || '')}</code></pre>`;
  }
  return html;
}

/* ── Write activity feed ─────────────────────────────────────────── */

const VAULT_ACTIONS = {
  create: 'created', update: 'updated', append: 'appended to',
  initialize: 'initialized', other: 'changed',
};

async function refreshVaultFeed() {
  const list = $('#vault-feed-list');
  if (!list) return;
  let items;
  try {
    items = await api('/api/vault/feed?limit=50');
  } catch (err) {
    list.replaceChildren(el('div', { class: 'vault-tree-empty' }, err.message));
    return;
  }
  list.replaceChildren(...items.map(vaultFeedRow));
  if (!items.length) list.append(el('div', { class: 'vault-tree-empty' }, 'No writes yet'));
}

function vaultFeedRow(it) {
  const verb = VAULT_ACTIONS[it.action] || 'changed';
  const pathBits = it.path ? it.path.split('/') : [];
  const fileName = pathBits.pop();
  const actions = [
    el('button', {
      class: 'btn sm', title: `Show the diff for ${it.hash}`,
      onclick: () => showVaultCommit(it.hash),
    }, '▤'),
  ];
  if (it.path) {
    actions.push(el('button', {
      class: 'btn sm danger', title: 'Revert this single write (a new commit; history keeps both)',
      onclick: () => revertVaultWrite(it),
    }, '↩'));
  }
  return el('div', { class: 'vault-feed-item' + (it.reserved ? ' reserved' : '') },
    el('div', { class: 'vault-feed-top' },
      el('span', { class: 'feed-time', title: it.subject }, fmtFeedTime(it.ts || Date.now())),
      el('span', { class: 'vault-feed-author', title: it.email || '' }, it.author || '?'),
      it.reserved ? el('span', { class: 'flag-badge', title: 'write into a reserved MC folder' }, '⚑ reserved') : null,
      el('span', { class: 'flex-spacer' }),
      ...actions,
    ),
    el('div', {
      class: 'vault-feed-what' + (it.path ? ' linkish' : ''),
      title: it.path || it.subject,
      onclick: () => it.path && openVaultNote(it.path),
    },
      it.revert ? el('span', { class: 'vault-feed-revert' }, '↩ reverted — ') : null,
      el('span', {}, `${verb} `),
      pathBits.length ? el('span', { class: 'vault-feed-dir' }, pathBits.join('/') + '/') : null,
      el('span', { class: 'vault-feed-file' }, fileName || it.subject),
    ),
  );
}

async function revertVaultWrite(it) {
  const what = it.path || it.hash;
  if (!confirm(`Revert this write?\n${what}\n\nA new commit restores the previous content — history keeps both.`)) return;
  try {
    const r = await api('/api/vault/revert', { method: 'POST', body: { hash: it.hash } });
    toast(`Reverted ${what}${r.commit ? ` (${r.commit})` : ''}`);
    await Promise.all([refreshVaultTree(), refreshVaultFeed()]);
    const v = vaultState();
    if (v.sel && !v.isNew) openVaultNote(v.sel);
  } catch (err) { toast(err.message, true); }
}

async function showVaultCommit(hash) {
  let data;
  try {
    data = await api(`/api/vault/commit?hash=${encodeURIComponent(hash)}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.append(
    el('div', { class: 'modal vault-diff' },
      el('div', { class: 'modal-head' },
        el('strong', {}, `Vault write ${hash}`),
        data.truncated ? el('span', { class: 'hint' }, 'diff truncated') : null,
        el('button', { class: 'btn sm modal-close', onclick: close }, '✕'),
      ),
      el('div', { class: 'modal-body vault-diff-body' }, renderDiffText(data.text)),
    ),
  );
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
}



/* ── Kanban board ────────────────────────────────────────────────── */

const KB_COLUMNS = [
  ['backlog', 'Backlog'],
  ['inprogress', 'In progress'],
  ['review', 'Review'],
  ['done', 'Done'],
];

function showMenu(x, y, items) {
  const menu = el('div', { class: 'ctx-menu', style: `left:${Math.min(x, innerWidth - 240)}px;top:${Math.min(y, innerHeight - items.length * 38 - 16)}px` },
    items.map((item) =>
      el('button', {
        class: 'ctx-item' + (item.disabled ? ' disabled' : ''),
        onclick: () => {
          if (item.disabled) return;
          cleanup();
          item.onclick();
        },
      }, item.label)
    )
  );
  const cleanup = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDoc, true);
  };
  const onDoc = (e) => { if (!menu.contains(e.target)) cleanup(); };
  document.body.append(menu);
  setTimeout(() => document.addEventListener('mousedown', onDoc, true));
}

// Cards go to an instance on the card's project; none running means launch
// one first (the launcher opens on the board's project).
function boardInstances() {
  return state.instances.filter((i) => i.projectId === state.boardProj);
}

function dispatchMenu(task, x, y) {
  const pool = boardInstances();
  if (!task.projectId) return toast('Cards on the default workspace can\'t be dispatched — every instance works in a project', true);
  if (!pool.length) {
    toast('No instances on this project — launch one first', true);
    agentLaunchState().projectId = task.projectId;
    return openAgentLauncher();
  }
  showMenu(x, y, pool.map((a) => ({
    label: `▶ ${a.agent}${a.status?.state === 'offline' ? ' (offline)' : a.status?.state === 'working' ? ' (will queue)' : ''}`,
    disabled: a.status?.state === 'offline',
    onclick: async () => {
      try {
        const r = await api(`/api/tasks/${task.id}/dispatch`, { method: 'POST', body: { instanceId: a.id } });
        toast(r.queued ? `Dispatched to ${a.name} — queued #${r.position}` : `Dispatched to ${a.name}`);
      } catch (err) { toast(err.message, true); }
    },
  })));
}

function renderBoard() {
  if (state.boardProj === undefined) state.boardProj = state.projects[0]?.id ?? null;
  if (state.boardProj !== null && !state.projects.some((p) => p.id === state.boardProj)) {
    state.boardProj = state.projects[0]?.id ?? null;
  }
  const cur = state.boardProj;
  const tasks = state.tasks.filter((t) => (t.projectId || null) === cur);

  const projSel = el('select', { class: 'hdr-model' },
    ...state.projects.map((p) => el('option', { value: p.id, selected: cur === p.id ? '' : null }, '▣ ' + p.name)),
    el('option', { value: '', selected: cur === null ? '' : null }, '▣ default workspace'),
  );
  projSel.onchange = () => { state.boardProj = projSel.value || null; renderBoard(); };

  // Instance chips (this project's) double as drag-to-dispatch drop targets.
  const pool = boardInstances();
  const agentChips = pool.map((a) => {
    const chip = el('div', { class: `kb-agent ${a.status?.state || 'offline'}`, title: a.name },
      el('span', { class: `dot ${a.status?.state || 'offline'}` }),
      el('span', {}, a.agent),
      a.status?.queue?.length ? el('span', { class: 'nav-queue-badge' }, String(a.status.queue.length)) : null,
    );
    chip.addEventListener('dragover', (e) => { e.preventDefault(); chip.classList.add('drop'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop'));
    chip.addEventListener('drop', async (e) => {
      e.preventDefault();
      chip.classList.remove('drop');
      const taskId = e.dataTransfer.getData('text/plain');
      if (!taskId) return;
      try {
        const r = await api(`/api/tasks/${taskId}/dispatch`, { method: 'POST', body: { instanceId: a.id } });
        toast(r.queued ? `Dispatched to ${a.name} — queued #${r.position}` : `Dispatched to ${a.name}`);
      } catch (err) { toast(err.message, true); }
    });
    return chip;
  });
  if (!agentChips.length && cur) {
    agentChips.push(el('button', {
      class: 'kb-agent kb-agent-launch',
      onclick: () => { agentLaunchState().projectId = cur; openAgentLauncher(); },
    }, '▶ launch an instance here'));
  }

  main.replaceChildren(
    el('div', { class: 'page board-page' },
      el('div', { class: 'board-head' },
        el('h1', { class: 'page-title' }, 'BOARD'),
        projSel,
        el('div', { class: 'kb-agents' },
          el('span', { class: 'kb-agents-label' }, 'drop on agent →'),
          agentChips),
      ),
      el('div', { class: 'kb-grid' },
        KB_COLUMNS.map(([key, label]) =>
          kanbanColumn(key, label, tasks.filter((t) => t.column === key))),
      ),
    )
  );
}

function kanbanColumn(key, label, tasks) {
  const col = el('div', { class: 'kb-col' });
  col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
  col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
  col.addEventListener('drop', async (e) => {
    e.preventDefault();
    col.classList.remove('drop');
    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId) return;
    try {
      await api('/api/tasks/' + taskId, { method: 'PUT', body: { column: key } });
    } catch (err) { toast(err.message, true); }
  });
  col.append(
    el('div', { class: 'kb-col-head' },
      el('span', {}, label),
      el('span', { class: 'kb-count' }, String(tasks.length)),
    ),
    el('div', { class: 'kb-cards' }, tasks.map(kanbanCard)),
  );
  if (key === 'backlog') {
    col.append(el('button', { class: 'kb-add', onclick: () => openTaskModal(null) }, '+ Add card'));
  }
  return col;
}

function kanbanCard(task) {
  const inst = task.instanceId ? getInstance(task.instanceId) : null;
  const agentName = inst ? inst.agent : (task.agentId ? getAgent(task.agentId)?.name || task.agentId : null);
  const card = el('div', { class: 'kb-card', draggable: 'true' },
    el('div', { class: 'kb-card-title' }, task.title),
    task.description ? el('div', { class: 'kb-card-desc' }, task.description) : null,
    el('div', { class: 'kb-card-foot' },
      agentName ? el('span', { class: 'kb-card-agent', title: inst ? inst.name : 'instance closed' },
        el('span', { class: `dot ${inst?.status?.state || 'offline'}` }), agentName) : null,
      task.result === 'error' ? el('span', { class: 'kb-badge err' }, 'failed') : null,
      task.result === 'stopped' ? el('span', { class: 'kb-badge warn' }, 'stopped') : null,
      el('span', { class: 'kb-spacer' }),
      task.cid ? el('button', {
        class: 'btn sm', title: 'Open the conversation that worked this card',
        onclick: (e) => {
          e.stopPropagation();
          if (inst) {
            state.sessionSel[inst.id] = task.cid;
            state.tab = 'sessions';
            location.hash = '#/instance/' + encodeURIComponent(inst.id);
          } else if (task.projectId) {
            location.hash = '#/project/' + encodeURIComponent(task.projectId) + '/' + encodeURIComponent(task.cid);
          }
        },
      }, '🗂') : null,
      task.column !== 'inprogress' ? el('button', {
        class: 'btn sm', title: 'Dispatch to agent',
        onclick: (e) => { e.stopPropagation(); dispatchMenu(task, e.clientX, e.clientY); },
      }, '▶') : null,
      task.column === 'review' ? el('button', {
        class: 'btn sm', title: 'Mark done',
        onclick: async (e) => {
          e.stopPropagation();
          try { await api('/api/tasks/' + task.id, { method: 'PUT', body: { column: 'done' } }); }
          catch (err) { toast(err.message, true); }
        },
      }, '✓') : null,
    ),
  );
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => openTaskModal(task));
  return card;
}

function openTaskModal(task) {
  const titleIn = el('input', { placeholder: 'Task title', value: task?.title || '' });
  const descIn = el('textarea', { class: 'commit-msg', rows: '5', placeholder: 'Description / instructions for the agent (optional)' });
  descIn.value = task?.description || '';

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  async function save() {
    try {
      const body = { title: titleIn.value, description: descIn.value };
      if (task) await api('/api/tasks/' + task.id, { method: 'PUT', body });
      else await api('/api/tasks', { method: 'POST', body: { ...body, projectId: state.boardProj } });
      close();
    } catch (err) { toast(err.message, true); }
  }

  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  },
    el('div', { class: 'modal modal-form' },
      el('div', { class: 'modal-head' },
        el('strong', {}, task ? 'Edit card' : 'New card'),
        el('button', { class: 'btn sm modal-close', onclick: close }, '✕'),
      ),
      el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', {}, 'Title'), titleIn),
        el('div', { class: 'field' }, el('label', {}, 'Description'), descIn),
      ),
      el('div', { class: 'modal-foot' },
        task ? el('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm('Delete this card?')) return;
            try { await api('/api/tasks/' + task.id, { method: 'DELETE' }); close(); }
            catch (err) { toast(err.message, true); }
          },
        }, 'Delete') : null,
        el('span', { class: 'kb-spacer' }),
        el('button', { class: 'btn', onclick: close }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: save }, task ? 'Save' : 'Create'),
      ),
    ),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  titleIn.focus();
}

/* ── Project conversations + local Claude Code history ──────────── */

// History belongs to the project (Round 5): every conversation any instance
// ran against it, newest first, then the native Claude Code sessions run from
// its folder in a terminal.
async function renderProjectHistory(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) {
    location.hash = '#/projects';
    return;
  }
  main.replaceChildren(el('div', { class: 'ws-empty', style: 'height:100%' }, 'Reading project history…'));
  let convs = [];
  let data = { sessions: [], parentSessions: [] };
  try {
    [convs, data] = await Promise.all([
      api(`/api/projects/${encodeURIComponent(projectId)}/conversations`),
      api(`/api/projects/${encodeURIComponent(projectId)}/claude-sessions`).catch(() => data),
    ]);
  } catch (err) {
    main.replaceChildren(el('div', { class: 'page' }, el('p', { class: 'page-sub' }, err.message)));
    return;
  }

  const list = el('div', { class: 'ws-list' });
  const detail = el('div', { class: 'sess-detail' });
  let selectedId = currentProjectCid();
  const local = [...data.sessions, ...(data.parentSessions || [])];

  main.replaceChildren(
    el('div', { class: 'agent-page' },
      el('header', { class: 'agent-header' },
        el('a', { href: '#/projects', class: 'btn sm' }, '← Projects'),
        el('h1', {}, project.name + ' — conversations'),
        el('span', { class: 'header-task', title: project.path },
          `${convs.length} from Mission Control · ${local.length} local Claude Code session${local.length === 1 ? '' : 's'}`),
        el('button', {
          class: 'btn primary sm',
          onclick: () => { agentLaunchState().projectId = projectId; openAgentLauncher(); },
        }, '▶ Launch instance'),
      ),
      el('div', { class: 'agent-body' },
        el('div', { class: 'ws-wrap' },
          el('div', { class: 'ws-tree', style: 'width:340px' },
            list,
          ),
          detail,
        ),
      ),
    )
  );

  function convEntry(c) {
    const inst = c.iid ? getInstance(c.iid) : null;
    return el('div', {
      class: 'sess-entry' + (c.cid === selectedId ? ' selected' : ''),
      onclick: () => openConversation(c),
    },
      el('div', { class: 'sess-title' },
        c.active ? el('span', { class: 'sess-badge' }, 'ACTIVE') : null,
        el('span', { class: 'sess-title-text' }, c.firstPrompt || '(no messages)'),
      ),
      el('div', { class: 'sess-meta' },
        el('span', { class: 'sess-proj', style: c.accent ? `color:${c.accent}` : null }, c.agent || 'unknown agent'),
        inst ? el('span', { class: `dot ${inst.status?.state || 'offline'}`, title: inst.name }) : null,
        c.origin ? originChip(c.origin, 'sm') : null,
        el('span', {}, new Date(c.startedAt).toLocaleString()),
        el('span', {}, `${c.prompts} msg`),
        c.failures ? el('span', { style: 'color:var(--red)' }, `${c.failures} failed`) : null,
        el('span', {}, fmtCost(c.cost, c.estimated)),
        c.durationMs ? el('span', {}, fmtDur(c.durationMs)) : null,
      ),
    );
  }

  function sessionEntry(s) {
    return el('div', {
      class: 'sess-entry' + (s.id === selectedId ? ' selected' : ''),
      onclick: () => openSession(s),
    },
      el('div', { class: 'sess-title' },
        el('span', { class: 'sess-title-text' }, s.title)),
      el('div', { class: 'sess-meta' },
        el('span', {}, new Date(s.startTs || s.mtime).toLocaleString()),
        s.model ? el('span', {}, s.model) : null,
        s.branch ? el('span', { class: 'sess-proj' }, '⎇ ' + s.branch) : null,
        el('span', {}, fmtBytes(s.size)),
      ),
      s.fromDir ? el('div', { class: 'sess-meta' },
        el('span', { title: s.fromDir }, '📂 ran from ' + s.fromDir.split('/').slice(-2).join('/'))) : null,
    );
  }

  function renderList() {
    list.replaceChildren(
      el('div', { class: 'git-section-title' }, `MISSION CONTROL — ${convs.length}`),
      ...convs.map(convEntry),
    );
    if (!convs.length) {
      list.append(el('div', { class: 'ws-empty', style: 'padding:14px 12px' },
        'No instance has run against this project yet.'));
    }
    list.append(el('div', { class: 'git-section-title' }, `LOCAL CLAUDE CODE — ${data.sessions.length}`));
    if (!data.sessions.length) {
      list.append(el('div', { class: 'ws-empty', style: 'padding:14px 12px' },
        'No terminal sessions ran from this exact folder.'));
    }
    list.append(...data.sessions.map(sessionEntry));
    if (data.parentSessions?.length) {
      list.append(
        el('div', { class: 'git-section-title' }, 'FROM PARENT FOLDERS'),
        ...data.parentSessions.map(sessionEntry),
      );
    }
  }

  function transcriptHead(label, s, extra) {
    return el('div', { class: 'sess-detail-head' },
      el('span', {}, label),
      el('span', {}, `${s.prompts} messages`),
      s.runs ? el('span', {}, `${s.runs} runs`) : null,
      s.cost || s.estimated ? el('span', {}, fmtCost(s.cost, s.estimated, 4)) : null,
      s.models.size ? el('span', {}, [...s.models].join(', ')) : null,
      extra,
      el('span', { class: 'kb-spacer' }),
      el('button', {
        class: 'btn sm',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(sessionToMarkdown({ name: project.name, id: projectId }, s));
            toast('Transcript copied as Markdown');
          } catch (err) { toast(err.message, true); }
        },
      }, '⧉ Copy'),
      el('button', {
        class: 'btn sm',
        onclick: () => downloadSessionMd({ name: project.name, id: projectId }, s),
      }, '⬇ Export'),
    );
  }

  function showTranscript(head, events) {
    const log = el('div', { class: 'chat-log' });
    detail.replaceChildren(head, log);
    for (const ev of events) {
      const node = renderEvent(ev);
      if (node) log.append(node);
    }
    log.scrollTop = log.scrollHeight;
  }

  async function openConversation(c) {
    selectedId = c.cid;
    renderList();
    detail.replaceChildren(el('div', { class: 'ws-empty' }, 'Loading conversation…'));
    let events;
    try {
      events = await api(`/api/projects/${encodeURIComponent(projectId)}/history?cid=${encodeURIComponent(c.cid)}`);
    } catch (err) {
      detail.replaceChildren(el('div', { class: 'ws-empty' }, err.message));
      return;
    }
    const s = computeSessions(events)[0] || { cid: c.cid, pid: projectId, events, startedAt: c.startedAt, endedAt: c.endedAt, prompts: 0, runs: 0, cost: 0, estimated: 0, models: new Set() };
    const inst = c.iid ? getInstance(c.iid) : null;
    showTranscript(transcriptHead(
      `${c.agent || 'agent'} · ${new Date(c.startedAt).toLocaleString()}`,
      s,
      inst ? el('a', { class: 'btn sm', href: `#/instance/${encodeURIComponent(inst.id)}` }, '↗ open instance')
        : el('span', { class: 'sess-proj' }, 'instance closed'),
    ), events);
  }

  async function openSession(s) {
    selectedId = s.id;
    renderList();
    detail.replaceChildren(el('div', { class: 'ws-empty' }, 'Loading transcript…'));
    let sess;
    try {
      sess = await api(`/api/projects/${projectId}/claude-sessions/${s.id}`);
    } catch (err) {
      detail.replaceChildren(el('div', { class: 'ws-empty' }, err.message));
      return;
    }
    const pseudo = {
      cid: s.id,
      pid: projectId,
      events: sess.events,
      startedAt: s.startTs || s.mtime,
      endedAt: s.mtime,
      runs: 0,
      cost: 0,
      estimated: 0,
      prompts: sess.events.filter((e) => e.type === 'user_prompt').length,
      models: new Set(s.model ? [s.model] : []),
    };
    showTranscript(transcriptHead(
      'local session ' + s.id.slice(0, 8),
      pseudo,
      sess.truncated ? el('span', {}, `(showing last ${sess.events.length} of ${sess.total} events)`) : null,
    ), sess.events);
  }

  renderList();
  const wanted = selectedId ? convs.find((c) => c.cid === selectedId) : null;
  if (wanted) openConversation(wanted);
  else if (convs[0]) openConversation(convs[0]);
  else if (local[0]) openSession(local[0]);
  else detail.append(el('div', { class: 'ws-empty' }, 'No transcripts to show'));
}

/* ── Folder picker modal ─────────────────────────────────────────── */

function openFolderPicker(initial, onPick) {
  let current = null;

  const pathEl = el('div', { class: 'picker-path' }, '…');
  const listEl = el('div', { class: 'picker-list' });

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  async function load(p) {
    let data;
    try {
      data = await api('/api/fs/dirs?path=' + encodeURIComponent(p || ''));
    } catch (err) {
      toast(err.message, true);
      return;
    }
    current = data.path;
    pathEl.textContent = data.path;
    const rows = [];
    if (data.parent) {
      rows.push(el('div', { class: 'ws-entry', onclick: () => load(data.parent) },
        el('span', {}, '↩'), el('span', { class: 'name' }, '..')));
    }
    for (const d of data.dirs) {
      rows.push(el('div', { class: 'ws-entry', onclick: () => load(d.path) },
        el('span', {}, '📁'), el('span', { class: 'name' }, d.name)));
    }
    if (!data.dirs.length) {
      rows.push(el('div', { class: 'ws-entry' }, el('span', { class: 'name' }, '(no subfolders)')));
    }
    listEl.replaceChildren(...rows);
  }

  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  },
    el('div', { class: 'modal' },
      el('div', { class: 'modal-head' },
        el('strong', {}, 'Choose root folder'),
        el('button', { class: 'btn sm', onclick: () => load('') }, '⌂ Home'),
        el('button', {
          class: 'btn sm',
          onclick: async () => {
            const name = prompt('New folder name:');
            if (!name) return;
            try {
              const made = await api('/api/fs/mkdir', { method: 'POST', body: { path: current, name } });
              await load(made.path);
            } catch (err) { toast(err.message, true); }
          },
        }, '+ New folder'),
        el('button', { class: 'btn sm modal-close', onclick: close }, '✕'),
      ),
      pathEl,
      listEl,
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn', onclick: close }, 'Cancel'),
        el('button', {
          class: 'btn primary',
          onclick: () => { if (current) onPick(current); close(); },
        }, 'Select this folder'),
      ),
    ),
  );

  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  load(initial || '');
}

/* ── Registered agent page ───────────────────────────────────────── */

// Definition view for one registered agent: what it is, its default settings,
// the instances running under it, and Remove (refused while any exist).
// The definition is edited through the same modal as registration (M21);
// this page stays read-only so the re-render on every broadcast is harmless.
async function renderAgentDetail(agent) {
  if (!agent) return renderHome();
  const kids = instancesOf(agent.id);
  const settingsPane = el('div', { id: 'agent-settings' }, el('div', { class: 'hint' }, 'Loading settings…'));
  const spendPane = el('div', { id: 'agent-spend' }, el('div', { class: 'hint' }, 'Loading…'));
  const kvRow = (k, v) => el('div', { class: 'kv' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
  const pricing = agent.pricing || null;
  const renewal = renewalText(pricing);
  const envRows = Object.entries(agent.env || {});
  const envText = !envRows.length ? 'inherits the server\'s'
    : el('div', { class: 'env-list' }, envRows.map(([k, v]) => el('div', {},
        el('span', { class: 'env-key' }, k), ' = ',
        v && typeof v === 'object' && v.file ? el('span', { class: 'env-file', title: 'read from this file at spawn' }, '📄 ' + v.file)
          : v && typeof v === 'object' && v.secret ? el('span', { class: 'env-secret' }, '••••••')
          : String(v))));
  main.replaceChildren(
    el('div', { class: 'page' },
      el('div', { class: 'home-head' },
        el('div', {},
          el('h1', { class: 'page-title', style: `--card-accent:${agent.accent || 'var(--accent)'}` },
            el('span', { class: 'nav-agent-swatch', style: `--agent-accent:${agent.accent || 'var(--accent)'}` }), ' ', agent.name.toUpperCase()),
          el('p', { class: 'page-sub' }, agent.description || 'Registered agent'),
        ),
        el('div', { class: 'btn-row' },
          el('button', {
            class: 'btn primary sm', disabled: agent.available ? null : '',
            onclick: () => openAgentLauncher(agent.id),
          }, '▶ Launch instance'),
          el('button', { class: 'btn sm', onclick: () => openAgentForm(agent) }, '✎ Edit'),
          el('button', {
            class: 'btn sm danger', disabled: kids.length ? '' : null,
            title: kids.length ? 'Close its instances first' : 'Remove this agent from the registry',
            onclick: async () => {
              if (!confirm(`Remove agent "${agent.name}"?\nProject histories keep every conversation it ran.`)) return;
              try {
                await api('/api/agents/' + encodeURIComponent(agent.id), { method: 'DELETE' });
                toast('Agent removed');
                location.hash = '#/';
              } catch (err) { toast(err.message, true); }
            },
          }, 'Remove'),
        ),
      ),
      el('div', { class: 'control-grid', style: 'margin-top:16px' },
        el('div', { class: 'panel' },
          el('h3', {}, 'Definition'),
          kvRow('Type', agent.type),
          kvRow('Availability', agent.available ? 'CLI found' : 'CLI not found on this machine'),
          kvRow('Models', agent.models?.length ? agent.models.map((m) => m.label || m.value).join(', ') : 'adapter defaults'),
          kvRow('Billing', pricingSummary(pricing)),
          renewal ? kvRow('Renews', el('span', { style: renewal.days <= 1 ? 'color:var(--amber)' : '' }, renewal.text)) : null,
          kvRow('Environment', envText),
          el('div', { class: 'hint', style: 'margin-top:10px' },
            'Instances inherit all of this at launch; edits reach running instances on their next run.'),
        ),
        el('div', { class: 'panel' },
          el('h3', {}, 'Default settings'),
          el('div', { class: 'hint' }, 'Starting point for every new instance; each instance can override these in its Control Room.'),
          settingsPane,
          el('h3', { style: 'margin-top:18px' }, 'Spend across projects'),
          spendPane,
        ),
        el('div', { class: 'panel span2' },
          el('h3', {}, `Instances — ${kids.length}`),
          kids.length
            ? el('div', { class: 'instance-list' }, kids.map(instanceRow))
            : el('div', { class: 'hint' }, 'None running. ▶ Launch instance starts one on a project.'),
        ),
      ),
    )
  );

  // Runs and cost for this agent summed over every project (analytics is
  // fleet-wide, so it is cached briefly — this page re-renders on every
  // instance broadcast).
  agentSpend(agent.id).then((row) => {
    if (!spendPane.isConnected) return;
    if (!row) { spendPane.replaceChildren(el('div', { class: 'hint' }, 'No runs recorded yet.')); return; }
    spendPane.replaceChildren(
      kvRow('Runs', `${row.runs}${row.failures ? ` · ${row.failures} failed` : ''}`),
      kvRow('Spend', fmtCost(row.cost, row.estimated)),
      row.avgMs ? kvRow('Avg run', fmtDur(row.avgMs)) : null,
      pricing?.plan && typeof pricing.amount === 'number'
        ? kvRow('Subscription', `${fmtMoney(pricing.amount, pricing.currency)}/${pricing.period === 'year' ? 'yr' : 'mo'}`) : null,
    );
  }).catch((err) => spendPane.replaceChildren(el('div', { class: 'hint' }, err.message)));

  let settings;
  try { settings = await api(`/api/agents/${encodeURIComponent(agent.id)}/settings`); }
  catch (err) { settingsPane.replaceChildren(el('div', { class: 'hint' }, err.message)); return; }
  settingsPane.replaceChildren(...settings.schema.map((field) => {
    const save = async (value) => {
      try {
        await api(`/api/agents/${encodeURIComponent(agent.id)}/settings`, { method: 'PUT', body: { [field.key]: value } });
        toast(`${field.label} default updated`);
      } catch (err) { toast(err.message, true); }
    };
    let input;
    if (field.type === 'text') {
      input = el('input', { placeholder: field.placeholder || '' });
      input.value = settings.values[field.key] ?? '';
      input.addEventListener('change', () => save(input.value.trim()));
    } else {
      input = el('select', { onchange: () => save(input.value) },
        (field.options || []).map((opt) =>
          el('option', { value: opt.value, selected: settings.values[field.key] === opt.value ? '' : null }, opt.label)));
    }
    return el('div', { class: 'field' }, el('label', {}, field.label), input);
  }));
  if (!settings.schema.length) settingsPane.replaceChildren(el('div', { class: 'hint' }, 'This adapter has no settings.'));
}

let analyticsCache = { at: 0, promise: null };
function agentSpend(agentId) {
  if (Date.now() - analyticsCache.at > 10000 || !analyticsCache.promise) {
    analyticsCache = { at: Date.now(), promise: api('/api/analytics') };
  }
  return analyticsCache.promise.then((data) => data.agents.find((a) => a.id === agentId) || null);
}

/* ── Instance page (Control Room) ────────────────────────────────── */

// `agent` here is an instance: one live session of a registered agent on one
// project. Its project is fixed at launch; the model is per instance.
function renderAgentPage(agent) {
  const tabs = [
    ['chat', 'Chat'],
    ['sessions', 'Sessions'],
    ['git', 'Git'],
    ['workspace', 'Workspace'],
    ['control', 'Control Room'],
  ];
  const st = agent.status || {};
  const def = getAgent(agent.agentId);
  main.replaceChildren(
    el('div', { class: 'agent-page' },
      el('header', { class: 'agent-header' },
        el('span', { class: `dot ${st.state || 'offline'}`, id: 'hdr-dot' }),
        el('h1', {}, agent.name),
        el('a', {
          class: 'hdr-chip', href: `#/agent/${encodeURIComponent(agent.agentId)}`,
          style: `--agent-accent:${agent.accent || 'var(--accent)'}`, title: 'Registered agent',
        }, el('span', { class: 'nav-agent-swatch' }), def?.name || agent.agent),
        el('span', { class: 'hdr-chip', title: st.project?.path || '' }, '▣ ' + (st.project?.name || projName(agent.projectId))),
        el('span', { class: 'header-task', id: 'hdr-task' }, ...headerTaskNodes(st)),
        el('select', { class: 'hdr-model', id: 'hdr-model', title: 'Model (this instance)' },
          el('option', {}, modelLabel(st))),
        el('div', { class: 'tabs' },
          tabs.map(([key, label]) =>
            el('button', {
              class: 'tab' + (state.tab === key ? ' active' : ''),
              onclick: () => { state.tab = key; renderAgentPage(agent); },
            }, label)
          )
        ),
      ),
      el('div', { class: 'agent-body', id: 'agent-body' }),
    )
  );
  const body = $('#agent-body');
  if (state.tab === 'chat') renderChat(agent, body);
  else if (state.tab === 'sessions') renderSessions(agent, body);
  else if (state.tab === 'git') renderGit(agent, body);
  else if (state.tab === 'workspace') renderWorkspace(agent, body);
  else renderControl(agent, body);
  populateModelSelect(agent);
  state.agentCid[agent.id] = st.cid || null;
}

// Fill the header model dropdown from the agent's settings schema; changing it
// persists the setting (takes effect on the next run).
async function populateModelSelect(agent) {
  const sel = $('#hdr-model');
  if (!sel || document.activeElement === sel) return;
  let settings;
  try {
    settings = await api(`/api/instances/${agent.id}/settings`);
  } catch {
    return;
  }
  const field = settings.schema.find((f) => f.key === 'model');
  if (!field || !field.options?.length) {
    sel.hidden = true;
    return;
  }
  sel.replaceChildren(
    ...(field.options || []).map((opt) =>
      el('option', { value: opt.value, selected: (settings.values.model || '') === opt.value ? '' : null },
        opt.value ? opt.label : 'Model: default')
    )
  );
  sel.onchange = async () => {
    try {
      await api(`/api/instances/${agent.id}/settings`, { method: 'PUT', body: { model: sel.value } });
      toast(`Model set to ${sel.options[sel.selectedIndex].textContent} — applies from the next message`);
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// Header line while a run is active: origin chip, the prompt, and the clock.
function headerTaskNodes(st) {
  if (!st.currentTask) return [];
  return [
    st.run ? originChip(st.run.origin, 'sm') : null,
    el('span', { class: 'header-task-text' }, '▸ ' + st.currentTask),
    st.run ? runClock(st.run, 'sm') : null,
  ].filter(Boolean);
}

function onStatusChanged(agentId) {
  const agent = getInstance(agentId);
  if (!agent) return;
  const st = agent.status || {};
  const cidChanged = (st.cid || null) !== (state.agentCid[agentId] ?? (st.cid || null));
  state.agentCid[agentId] = st.cid || null;

  if (currentInstanceId() === agentId) {
    const dot = $('#hdr-dot');
    if (dot) dot.className = `dot ${st.state || 'offline'}`;
    const task = $('#hdr-task');
    if (task) task.replaceChildren(...headerTaskNodes(st));
    const body = $('#agent-body');
    if (state.tab === 'chat') {
      if (cidChanged && body) renderChat(agent, body);
      else {
        updateWorkingBar(agent);
        updateQueueBar(agent);
      }
    }
    if (state.tab === 'control') refreshControlInfo(agent);
    populateModelSelect(agent);
  } else if (onBoardPage()) {
    renderBoard();
  } else if (currentAgentId()) {
    const a = getAgent(currentAgentId());
    if (a) renderAgentDetail(a);
  } else if (!currentInstanceId() && !onOtherPage()) {
    renderHome();
  }
}

/* ── Chat tab ────────────────────────────────────────────────────── */

function updatePartialBubble(text) {
  const log = $('#chat-log');
  if (!log) return;
  let bubble = $('#partial-bubble');
  if (!text) {
    bubble?.remove();
    return;
  }
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  if (!bubble) {
    bubble = el('div', { class: 'msg msg-assistant partial', id: 'partial-bubble' });
    log.append(bubble);
  }
  bubble.innerHTML = renderMarkdown(text);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

const REF_MIME = 'application/x-mission-control-ref';

// Files staged for the next message. Two kinds: uploads copied into
// `.attachments/` via the 📎 button / paste / OS drop, and references to
// files or folders already in the workspace (dragged from a file tree).
function stagedFor(agent) {
  return (state.attach ||= {})[agent.id] ||= [];
}

function stageRef(agent, ref) {
  const staged = stagedFor(agent);
  if (staged.some((a) => a.path === ref.path)) return false;
  staged.push({ name: ref.name, path: ref.path, type: ref.type || 'file', kind: 'ref' });
  renderAttachChips(agent);
  return true;
}

function renderAttachChips(agent) {
  const row = $('#attach-row');
  if (!row) return;
  const staged = stagedFor(agent);
  row.replaceChildren(
    ...staged.map((a, i) =>
      el('span', { class: 'attach-chip' + (a.kind === 'ref' ? ' ref' : ''), title: a.path },
        (a.kind === 'ref' ? (a.type === 'dir' ? '📁 ' : '📄 ') : '📎 ') + a.name,
        el('button', { class: 'attach-x', onclick: () => { staged.splice(i, 1); renderAttachChips(agent); } }, '✕'),
      ))
  );
}

function readRef(dt) {
  try {
    const raw = dt?.getData(REF_MIME);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* ── Voice prompting (M16) ────────────────────────────────────────── */

// Two transcription backends, picked per use from the 🎤 button:
// - Whisper — the browser records a clip, the server sends it to OpenAI's
//   transcription API (key + model configured in the picker's settings).
// - Built-in dictation — the browser's own SpeechRecognition, no key. Claude
//   Code's hold-to-talk can't be driven headlessly through the CLI, so this is
//   the dashboard's keyless equivalent, and it works for every adapter.
// Both land in the composer as editable text — nothing is ever auto-sent. The
// session lives in module state so a chat re-render (project/conversation
// change) doesn't kill a recording in progress.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const VOICE_MAX_MS = 120 * 1000;   // auto-stop long Whisper recordings
let voiceTimer = null;
let voiceEsc = null;

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Drop transcribed text into the live composer — or the draft store if the
// chat view has moved on — following the prompt library's append pattern.
function insertComposerText(agentId, text) {
  const input = $('#composer-input');
  if (input && currentInstanceId() === agentId) {
    input.value = input.value ? input.value.replace(/\s+$/, '') + '\n' + text : text;
    input.dispatchEvent(new Event('input'));   // re-grow + re-save draft
    input.focus();
  } else {
    state.drafts[agentId] = state.drafts[agentId]
      ? state.drafts[agentId].replace(/\s+$/, '') + '\n' + text : text;
  }
}

// The live mic button (one composer is rendered at a time) mirrors the session.
function updateMicBtns() {
  const btn = $('.mic-btn');
  if (!btn) return;
  const v = state.voice && state.voice.agentId === currentInstanceId() ? state.voice : null;
  if (!v) {
    btn.classList.remove('rec');
    btn.textContent = '🎤';
    return;
  }
  btn.classList.add('rec');
  btn.textContent = (v.backend === 'whisper' ? '⏺ ' : '◉ ') + fmtElapsed(Date.now() - v.startedAt);
}

function armVoiceUi() {
  if (!voiceTimer) voiceTimer = setInterval(updateMicBtns, 500);
  if (!voiceEsc) {
    voiceEsc = (e) => {
      // Esc while the composer itself has focus belongs to its own handlers
      // (slash menu); a second Esc discards the voice session.
      if (e.key === 'Escape' && e.target?.id !== 'composer-input') stopVoice(true);
    };
    document.addEventListener('keydown', voiceEsc, true);
  }
  updateMicBtns();
}

function disarmVoiceUi() {
  clearInterval(voiceTimer);
  voiceTimer = null;
  if (voiceEsc) {
    document.removeEventListener('keydown', voiceEsc, true);
    voiceEsc = null;
  }
  updateMicBtns();
}

// Stop the active session. `discard` drops the audio/text (Esc); the normal
// path finishes it — Whisper transcribes, dictation keeps its final text.
function stopVoice(discard = false) {
  const v = state.voice;
  if (!v) return;
  v.discard = discard;
  if (v.backend === 'whisper') {
    if (v.recorder.state !== 'inactive') v.recorder.stop();
  } else {
    try { v.rec.stop(); } catch {}   // fires onend, which finalizes
  }
}

async function startWhisper(agent) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast(`Microphone unavailable: ${err.message}`, true);
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const v = { backend: 'whisper', agentId: agent.id, startedAt: Date.now(), recorder, chunks: [], discard: false };
  recorder.ondataavailable = (e) => { if (e.data.size) v.chunks.push(e.data); };
  recorder.onstop = () => {
    clearTimeout(v.cap);
    stream.getTracks().forEach((t) => t.stop());
    if (state.voice === v) {
      state.voice = null;
      disarmVoiceUi();
    }
    if (v.discard) return;
    if (!v.chunks.length) return toast('Nothing recorded', true);
    transcribe(agent, v.chunks, recorder.mimeType || mime);
  };
  recorder.start(250);
  state.voice = v;
  v.cap = setTimeout(() => {
    if (state.voice === v) {
      toast('Recording capped at 2 minutes — transcribing');
      stopVoice();
    }
  }, VOICE_MAX_MS);
  armVoiceUi();
}

async function transcribe(agent, chunks, mime) {
  const chip = el('span', { class: 'attach-chip' }, '⧗ transcribing…');
  $('#attach-row')?.append(chip);
  try {
    const blob = new Blob(chunks, { type: mime });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const r = await api('/api/transcribe', {
      method: 'POST',
      body: { dataBase64: String(dataUrl).split(',')[1] || '', mime },
    });
    if (r.text) insertComposerText(agent.id, r.text);
    else toast('Whisper returned no text', true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    chip.remove();
  }
}

function startDictate(agent) {
  const rec = new SpeechRec();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  const input = $('#composer-input');
  const v = {
    backend: 'dictate', agentId: agent.id, startedAt: Date.now(), rec,
    base: input && currentInstanceId() === agent.id ? input.value : (state.drafts[agent.id] || ''),
    final: '', interim: '', expected: null, discard: false,
  };
  rec.onresult = (e) => {
    v.final = '';
    v.interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) v.final += e.results[i][0].transcript;
      else v.interim += e.results[i][0].transcript;
    }
    applyDictation(v, false);
  };
  rec.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') toast(`Dictation: ${e.error}`, true);
  };
  rec.onend = () => {
    if (state.voice === v) {
      state.voice = null;
      disarmVoiceUi();
    }
    if (!v.discard) applyDictation(v, true);
  };
  try {
    rec.start();
  } catch (err) {
    toast(`Dictation: ${err.message}`, true);
    return;
  }
  state.voice = v;
  v.expected = v.base;   // nothing written yet; the composer holds `base`
  armVoiceUi();
}

// Mirror base + final (+ live interim) into the composer. If the text changed
// underneath us — the user typed, or a send cleared the box — rebase onto what
// is there now instead of resurrecting what we last wrote.
function applyDictation(v, finalOnly) {
  const live = $('#composer-input');
  const inView = live && currentInstanceId() === v.agentId;
  const current = inView ? live.value : (state.drafts[v.agentId] || '');
  if (current !== v.expected) {
    v.base = current;
    v.final = '';
    v.interim = '';
  }
  const text = v.base + (finalOnly ? v.final : v.final + v.interim);
  if (inView) {
    live.value = text;
    live.dispatchEvent(new Event('input'));
    if (finalOnly) live.focus();
  } else {
    state.drafts[v.agentId] = text;
  }
  v.expected = text;
}

// Whisper settings: configured where they're used, from the 🎤 picker.
function openVoiceModal() {
  const keyIn = el('input', { type: 'password', placeholder: 'sk-…', autocomplete: 'off' });
  const modelIn = el('input', { type: 'text', placeholder: 'whisper-1' });
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  api('/api/voice')
    .then((c) => { keyIn.value = c.whisperKey; modelIn.value = c.whisperModel; })
    .catch(() => {});
  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  },
    el('div', { class: 'modal modal-form' },
      el('div', { class: 'modal-head' },
        el('strong', {}, 'Voice — Whisper'),
        el('button', { class: 'btn sm modal-close', onclick: close }, '✕'),
      ),
      el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', {}, 'OpenAI API key'), keyIn),
        el('div', { class: 'field' }, el('label', {}, 'Model'), modelIn),
        el('p', { class: 'hint' }, 'Used by the server to transcribe 🎤 recordings. Built-in dictation needs no key.'),
      ),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn', onclick: close }, 'Cancel'),
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await api('/api/voice', { method: 'PUT', body: { whisperKey: keyIn.value, whisperModel: modelIn.value.trim() } });
              state.voiceCfg = null;   // picker re-fetches next open
              toast('Voice settings saved');
              close();
            } catch (err) {
              toast(err.message, true);
            }
          },
        }, 'Save'),
      ),
    ),
  );
  document.body.append(overlay);
  keyIn.focus();
}

// Per-use backend picker on the 🎤 button.
async function micMenu(agent, x, y) {
  if (!state.voiceCfg || Date.now() - state.voiceCfg.at > 30000) {
    try { state.voiceCfg = { at: Date.now(), ...(await api('/api/voice')) }; }
    catch { state.voiceCfg = { at: Date.now(), whisperKey: '' }; }
  }
  const items = [];
  if (state.voiceCfg.whisperKey) items.push({ label: '⏺ Record → Whisper', onclick: () => startWhisper(agent) });
  if (SpeechRec) items.push({ label: '◉ Dictate — built-in, live', onclick: () => startDictate(agent) });
  if (!items.length) {
    items.push({ label: '🔑 Add OpenAI API key for Whisper…', onclick: openVoiceModal });
    if (!SpeechRec) items.push({ label: 'This browser has no built-in dictation', disabled: true });
  } else {
    items.push({ label: '⚙ Whisper settings…', onclick: openVoiceModal });
  }
  showMenu(x, y, items);
}

function micButton(agent) {
  return el('button', {
    class: 'btn composer-btn mic-btn',
    title: 'Voice prompt — record or dictate into the composer',
    onclick: (e) => {
      const v = state.voice;
      if (v) {
        // One session at a time: clicking again finishes it.
        if (v.agentId !== agent.id) return toast(`Already ${v.backend === 'whisper' ? 'recording' : 'dictating'} for another instance`, true);
        stopVoice();
        return;
      }
      micMenu(agent, e.clientX, e.clientY - 10);
    },
  }, '🎤');
}

function renderChat(agent, body) {
  const log = el('div', { class: 'chat-log', id: 'chat-log' });
  const workingSlot = el('div', { id: 'working-slot' });
  const attachRow = el('div', { class: 'attach-row', id: 'attach-row' });
  const staged = stagedFor(agent);
  const input = el('textarea', {
    id: 'composer-input',
    placeholder: `Message ${agent.name}…  (Enter to send, Shift+Enter for newline, paste/drop files to attach)`,
    rows: '1',
  });
  // Restore the unsent draft, like staged attachments above.
  input.value = state.drafts[agent.id] || '';
  // Slash-command picker: typing `/` at the start of the message lists the
  // skills and commands available to this agent (project .claude/, the
  // user's ~/.claude, and whatever the CLI reported last run), filtered as
  // you type. Enter/Tab inserts the highlighted one; Esc dismisses.
  const slashMenu = el('div', { class: 'slash-menu hidden' });
  const slash = { items: null, shown: [], idx: 0, open: false, query: '' };

  async function loadSkills() {
    const cached = state.skillsCache[agent.id];
    if (cached && Date.now() - cached.at < 30000) return cached.items;
    let items = [];
    try { items = await api(`/api/instances/${agent.id}/skills`); } catch {}
    state.skillsCache[agent.id] = { at: Date.now(), items };
    return items;
  }

  function slashToken() {
    const before = input.value.slice(0, input.selectionStart);
    const m = /^\/([\w:.-]*)$/.exec(before);
    return m ? m[1] : null;
  }

  function closeSlash() {
    slash.open = false;
    slashMenu.classList.add('hidden');
    slashMenu.replaceChildren();
  }

  function pickSlash(item) {
    const rest = input.value.slice(input.selectionStart);
    input.value = '/' + item.name + ' ' + rest.replace(/^\s+/, '');
    const caret = item.name.length + 2;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  function renderSlash() {
    slashMenu.replaceChildren();
    if (!slash.shown.length) {
      if (slash.query || (slash.items && slash.items.length)) return closeSlash();
      slashMenu.append(el('div', { class: 'slash-empty' },
        slash.items ? 'No skills found for this agent yet — send it one message and the CLI will report what it has.' : 'Loading skills…'));
    }
    slash.shown.forEach((item, i) => {
      const row = el('div', {
        class: 'slash-item' + (i === slash.idx ? ' active' : ''),
        onmousedown: (e) => { e.preventDefault(); pickSlash(item); },
        onmousemove: () => { if (slash.idx !== i) { slash.idx = i; renderSlash(); } },
      },
        el('span', { class: 'slash-name' }, '/' + item.name),
        el('span', { class: 'slash-desc' }, item.description || ''),
        el('span', { class: 'slash-src' }, item.source),
      );
      slashMenu.append(row);
    });
    slash.open = true;
    slashMenu.classList.remove('hidden');
    const active = slashMenu.querySelector('.slash-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  async function updateSlash() {
    const q = slashToken();
    if (q === null) return closeSlash();
    const changed = q !== slash.query;
    slash.query = q;
    if (!slash.items) {
      renderSlash();
      slash.items = await loadSkills();
      if (slashToken() === null) return closeSlash();
    }
    const needle = q.toLowerCase();
    const starts = slash.items.filter((s) => s.name.toLowerCase().startsWith(needle));
    const contains = slash.items.filter((s) => !starts.includes(s) &&
      (s.name.toLowerCase().includes(needle) || (s.description || '').toLowerCase().includes(needle)));
    slash.shown = [...starts, ...contains].slice(0, 12);
    if (changed || slash.idx >= slash.shown.length) slash.idx = 0;
    renderSlash();
  }

  function slashKey(e) {
    if (!slash.open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!slash.shown.length) return false;
      const n = slash.shown.length;
      slash.idx = (slash.idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderSlash();
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      if (!slash.shown.length) return false;
      pickSlash(slash.shown[slash.idx]);
    } else if (e.key === 'Escape') {
      closeSlash();
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  }

  input.addEventListener('keydown', (e) => {
    if (slashKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    state.drafts[agent.id] = input.value;
    updateSlash();
  });
  input.addEventListener('click', updateSlash);
  input.addEventListener('blur', closeSlash);
  const sendBtn = el('button', { class: 'btn primary', onclick: submit }, 'Send');

  async function uploadFile(file) {
    if (file.size > 20 * 1024 * 1024) return toast(`${file.name}: too large (20MB max)`, true);
    const chip = el('span', { class: 'attach-chip' }, '⧗ ' + file.name);
    attachRow.append(chip);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const dataBase64 = String(dataUrl).split(',')[1] || '';
      const saved = await api(`/api/instances/${agent.id}/attach`, {
        method: 'POST',
        body: { name: file.name, dataBase64 },
      });
      staged.push({ name: saved.name, path: saved.path, type: 'file', kind: 'upload' });
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
    renderAttachChips(agent);
  }

  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      files.forEach(uploadFile);
    }
  });

  const attachBtn = el('button', {
    class: 'btn composer-btn', title: 'Attach files',
    onclick: () => {
      const picker = el('input', { type: 'file', multiple: '' });
      picker.onchange = () => [...picker.files].forEach(uploadFile);
      picker.click();
    },
  }, '📎');

  const filesOpen = localStorage.getItem('mc.chatFiles') === '1';
  const filesBtn = el('button', {
    class: 'btn composer-btn' + (filesOpen ? ' active' : ''),
    title: filesOpen ? 'Hide project files' : 'Show project files — drag a file or folder into the message',
    onclick: () => {
      localStorage.setItem('mc.chatFiles', filesOpen ? '0' : '1');
      renderChat(agent, body);
    },
  }, '🗂');

  const promptsBtn = el('button', {
    class: 'btn composer-btn', title: 'Prompt library',
    onclick: async (e) => {
      let prompts = [];
      try { prompts = await api('/api/prompts'); } catch {}
      const pid = agent.status?.project?.id || null;
      const usable = prompts.filter((p) => !p.projectId || p.projectId === pid);
      showMenu(e.clientX, e.clientY - 10, [
        ...usable.map((p) => ({
          label: '📄 ' + p.name + (p.projectId ? ' (project)' : ''),
          onclick: () => {
            input.value = input.value ? input.value + '\n' + p.text : p.text;
            input.dispatchEvent(new Event('input'));
            input.focus();
          },
        })),
        { label: '✎ Manage prompts…', onclick: () => openPromptsModal(agent) },
      ]);
    },
  }, '☰');

  const newSessionBtn = el('button', {
    class: 'btn composer-btn new-session-btn', title: 'Start a new session (keeps history in the Sessions tab)',
    onclick: async () => {
      if (agent.status?.state === 'working' &&
          !confirm('The agent is mid-run. Start a new session anyway?')) return;
      try {
        await api(`/api/instances/${agent.id}/session/clear`, { method: 'POST' });
        toast('New session started');
      } catch (err) {
        toast(err.message, true);
      }
    },
  }, '✦ New session');

  async function submit() {
    let text = input.value.trim();
    if (!text && !staged.length) return;
    if (staged.length) {
      text += (text ? '\n\n' : '') +
        'Files and folders for context (read files with your Read tool; list a folder before reading inside it):\n' +
        staged.map((a) => '- ' + a.path + (a.type === 'dir' ? '/' : '')).join('\n');
    }
    // Clear before the request, not after: a status broadcast can re-render
    // the chat while the POST is in flight (new cid when the run starts), and
    // clearing then would hit the replaced textarea — leaving the sent text
    // sitting in the box. The draft comes back if the send fails.
    const draft = input.value;
    input.value = '';
    input.style.height = 'auto';
    state.drafts[agent.id] = '';
    try {
      const result = await api(`/api/instances/${agent.id}/chat`, { method: 'POST', body: { message: text } });
      if (result.queued) toast(`Queued — position ${result.position}`);
      staged.length = 0;
      renderAttachChips(agent);
    } catch (err) {
      if (input.isConnected && !input.value) {
        input.value = draft;
        input.dispatchEvent(new Event('input'));   // re-grow + re-save draft
        input.focus();
      } else if (!input.isConnected) {
        state.drafts[agent.id] = draft;   // chat re-rendered mid-flight; draft returns on the next render
      }
      toast(err.message, true);
    }
  }

  const wrap = el('div', { class: 'chat-wrap' },
    log,
    workingSlot,
    el('div', { id: 'queue-slot' }),
    attachRow,
    el('div', { class: 'composer' }, slashMenu, newSessionBtn, attachBtn, filesBtn, promptsBtn, micButton(agent), input, sendBtn),
  );
  // Drop targets: a row dragged from a file tree becomes a reference chip;
  // anything else (files from the OS) is uploaded as an attachment.
  wrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    if ([...(e.dataTransfer?.types || [])].includes(REF_MIME)) {
      e.dataTransfer.dropEffect = 'copy';
      wrap.classList.add('drop-ref');
    }
  });
  wrap.addEventListener('dragleave', (e) => {
    if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('drop-ref');
  });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop-ref');
    const ref = readRef(e.dataTransfer);
    if (ref) {
      stageRef(agent, ref);
      input.focus();
      return;
    }
    [...(e.dataTransfer?.files || [])].forEach(uploadFile);
  });
  body.replaceChildren(filesOpen ? el('div', { class: 'chat-split' }, wrap, chatFilesPanel(agent, input, filesBtn)) : wrap);
  renderAttachChips(agent);
  updateMicBtns();   // a voice session started before this re-render keeps its button state
  if (input.value) input.dispatchEvent(new Event('input'));   // re-grow restored draft

  // Chat shows the active session only; older sessions live in the Sessions tab.
  const cid = agent.status?.cid || null;
  const events = (state.histories[agent.id] || []).filter((ev) => cid && ev.cid === cid);
  for (const ev of events) {
    const node = renderEvent(ev);
    if (node) log.append(node);
  }
  if (!events.length) {
    log.append(el('div', { class: 'meta-line' },
      `fresh session in ${agent.status?.project?.name || projName(agent.projectId)} — send a message to begin`));
  }
  updateWorkingBar(agent);
  updateQueueBar(agent);
  log.scrollTop = log.scrollHeight;
  input.focus();
}

// Side panel on the Chat tab: the workspace tree, so files and folders can be
// dragged straight into the message being composed.
function chatFilesPanel(agent, input, toggleBtn) {
  const proj = agent.status?.project;
  const tree = fileTree(agent, {
    onOpen: (entry) => {
      (state.wsFile[agent.id] ||= { dir: '', selected: null }).selected = entry.path;
      state.tab = 'workspace';
      renderAgentPage(agent);
    },
    onAdd: (ref) => { stageRef(agent, ref); input.focus(); },
  });
  return el('aside', { class: 'chat-files' },
    el('div', { class: 'ws-tree-head' },
      el('span', { class: 'crumb', title: proj?.path || 'agent workspace' }, '🗂 ' + (proj ? proj.name : 'workspace')),
      el('button', { class: 'btn sm', title: 'Refresh', onclick: () => tree.reload() }, '↻'),
      el('button', { class: 'btn sm', title: 'Hide', onclick: () => toggleBtn.click() }, '✕'),
    ),
    el('div', { class: 'ws-tree-hint' },
      'Drag a file or folder into the message, or hover a row and press +. Click a file to open it in Workspace.'),
    tree,
  );
}

function updateWorkingBar(agent) {
  const slot = $('#working-slot');
  if (!slot) return;
  const st = agent.status || {};
  if (st.state === 'working') {
    const subs = st.subagents || [];
    slot.replaceChildren(...[
      el('div', { class: 'working-bar' },
        el('span', { class: 'spinner' }),
        st.run ? originChip(st.run.origin, 'sm') : null,
        el('span', { class: 'working-text' }, st.currentTask || 'working…'),
        st.run ? runClock(st.run, 'sm') : null,
        el('button', {
          class: 'btn sm danger stop-btn',
          onclick: () => api(`/api/instances/${agent.id}/stop`, { method: 'POST' }).catch((e) => toast(e.message, true)),
        }, 'Abort'),
      ),
      subs.length ? el('div', { class: 'subagent-row' },
        subs.map((s) =>
          el('span', { class: 'subagent-chip', title: s.description },
            el('span', { class: 'dot working' }),
            `⑂ ${s.type}`,
            s.description ? el('span', { class: 'sub-desc' }, s.description) : null,
          ))
      ) : null,
    ].filter(Boolean));
  } else {
    slot.replaceChildren();
  }
}

function updateQueueBar(agent) {
  const slot = $('#queue-slot');
  if (!slot) return;
  const queue = agent.status?.queue || [];
  if (!queue.length) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(
    el('div', { class: 'queue-bar' },
      el('div', { class: 'queue-title' }, `⧗ QUEUE — ${queue.length} waiting`),
      ...queue.map((task, i) =>
        el('div', { class: 'queue-item' },
          el('span', { class: 'queue-pos' }, String(i + 1)),
          task.origin && task.origin.kind !== 'chat' ? originChip(task.origin, 'sm') : null,
          el('span', { class: 'queue-text', title: task.text },
            task.text.length > 90 ? task.text.slice(0, 90) + '…' : task.text),
          el('button', {
            class: 'btn sm', disabled: i === 0 ? '' : null,
            onclick: () => moveQueueTask(agent, i, -1),
          }, '↑'),
          el('button', {
            class: 'btn sm', disabled: i === queue.length - 1 ? '' : null,
            onclick: () => moveQueueTask(agent, i, 1),
          }, '↓'),
          el('button', {
            class: 'btn sm danger',
            onclick: async () => {
              try {
                await api(`/api/instances/${agent.id}/queue/${task.id}`, { method: 'DELETE' });
              } catch (err) { toast(err.message, true); }
            },
          }, '✕'),
        )
      ),
    )
  );
}

async function moveQueueTask(agent, index, delta) {
  const queue = [...(agent.status?.queue || [])];
  const [task] = queue.splice(index, 1);
  queue.splice(index + delta, 0, task);
  try {
    await api(`/api/instances/${agent.id}/queue/reorder`, {
      method: 'POST',
      body: { order: queue.map((t) => t.id) },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

function onAgentEvent(agentId, event) {
  if (currentInstanceId() !== agentId) return;
  if (state.tab === 'chat') {
    const log = $('#chat-log');
    if (!log) return;
    if (event.type === 'assistant' || event.type === 'result' || event.type === 'error') {
      $('#partial-bubble')?.remove();
    }
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    const node = renderEvent(event);
    if (node) log.append(node);
    if (nearBottom) log.scrollTop = log.scrollHeight;
  } else if (state.tab === 'sessions') {
    const body = $('#agent-body');
    const log = $('#sess-log');
    const cids = new Set((state.histories[agentId] || []).map((e) => e.cid || 's-0'));
    if (body && body.dataset.sessCount !== String(cids.size)) {
      // A new session appeared (e.g. "New session" was clicked) — refresh the list.
      const agent = getInstance(agentId);
      if (agent) renderSessions(agent, body);
    } else if (log && state.sessionSel[agentId] === event.cid) {
      const node = renderEvent(event);
      if (node) log.append(node);
      log.scrollTop = log.scrollHeight;
    }
  } else if (state.tab === 'git') {
    // A finished run likely changed files — refresh the review pane.
    if (event.type === 'result') {
      const agent = getInstance(agentId);
      const body = $('#agent-body');
      if (agent && body) renderGit(agent, body);
    }
  } else if (state.tab === 'control') {
    appendLogLine(event);
  }
}

function toolInputSummary(input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.command || input.file_path || input.pattern || input.path ||
    input.url || input.description || input.prompt || input.query;
  const s = typeof pick === 'string' ? pick : JSON.stringify(input);
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function renderEvent(ev) {
  switch (ev.type) {
    case 'user_prompt': {
      // Plain chat messages carry no badge; anything else says where it came from.
      const chip = ev.origin && ev.origin.kind !== 'chat' ? originChip(ev.origin, 'sm msg-origin') : null;
      if (!chip) return el('div', { class: 'msg msg-user' }, ev.text);
      return el('div', { class: 'msg msg-user' }, chip, el('div', {}, ev.text));
    }

    case 'system':
      if (ev.subtype === 'init') {
        return el('div', { class: 'meta-line' },
          `▸ session ${String(ev.session_id || '').slice(0, 8)} · ${ev.model || ''}`);
      }
      return null;

    case 'assistant': {
      const blocks = ev.message?.content || [];
      const nodes = [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text?.trim()) {
          const div = el('div', { class: 'msg msg-assistant' });
          div.innerHTML = renderMarkdown(block.text);
          nodes.push(div);
        } else if (block.type === 'tool_use') {
          nodes.push(
            el('details', { class: 'tool-chip' },
              el('summary', {},
                el('span', { class: 'tool-name' }, '⚙ ' + block.name),
                el('span', {}, toolInputSummary(block.input)),
              ),
              el('pre', {}, JSON.stringify(block.input, null, 2)),
            )
          );
        }
      }
      if (!nodes.length) return null;
      const frag = document.createDocumentFragment();
      nodes.forEach((n) => frag.append(n));
      return frag;
    }

    case 'user': {
      // Tool results coming back to the model.
      const blocks = ev.message?.content;
      if (!Array.isArray(blocks)) return null;
      const frag = document.createDocumentFragment();
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        let text = '';
        if (typeof block.content === 'string') text = block.content;
        else if (Array.isArray(block.content)) {
          text = block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        }
        text = (text || '(no output)').trim();
        const firstLine = text.split('\n')[0].slice(0, 90);
        frag.append(
          el('details', { class: 'tool-chip result' },
            el('summary', {},
              el('span', { class: 'tool-name' }, block.is_error ? '✗ error' : '✓ result'),
              el('span', {}, firstLine),
            ),
            el('pre', {}, text.slice(0, 8000)),
          )
        );
      }
      return frag.childNodes.length ? frag : null;
    }

    case 'result': {
      if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
        return el('div', { class: 'meta-line error' }, `✗ run failed (${ev.subtype || 'error'})`);
      }
      const secs = ev.duration_ms ? (ev.duration_ms / 1000).toFixed(1) + 's' : '';
      const est = typeof ev.estimated_cost_usd === 'number' ? ` · ≈$${ev.estimated_cost_usd.toFixed(4)} at list price` : '';
      const cost = ev.cost_basis === 'subscription'
        ? (ev.plan ? `${ev.plan} (no marginal cost)` : 'included in plan') + est
        : typeof ev.total_cost_usd === 'number' ? `$${ev.total_cost_usd.toFixed(4)}` : '';
      return el('div', { class: 'meta-line' }, ['✓ done', secs, cost].filter(Boolean).join(' · '));
    }

    case 'meta':
      return el('div', { class: 'meta-line' }, ev.text);

    case 'error':
    case 'stderr':
      return el('div', { class: 'meta-line error' }, ev.text);

    default:
      return null;
  }
}

/* ── Prompt library modal ────────────────────────────────────────── */

async function openPromptsModal(agent) {
  const listEl = el('div', { class: 'prompt-list' });
  const nameIn = el('input', { placeholder: 'Prompt name (shown in the menu)' });
  const textIn = el('textarea', { class: 'commit-msg', rows: '4', placeholder: 'Prompt text…' });
  const proj = agent?.status?.project;
  const scopeSel = el('select', {},
    el('option', { value: '' }, 'Global — every agent'),
    ...(proj ? [el('option', { value: proj.id }, `Project: ${proj.name}`)] : []),
    ...state.projects.filter((p) => p.id !== proj?.id).map((p) => el('option', { value: p.id }, `Project: ${p.name}`)),
  );
  let editing = null;

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  async function refresh() {
    let prompts = [];
    try { prompts = await api('/api/prompts'); } catch {}
    listEl.replaceChildren(
      ...prompts.map((p) =>
        el('div', { class: 'prompt-item' },
          el('div', { class: 'prompt-item-main' },
            el('strong', {}, p.name),
            el('span', { class: 'prompt-scope' }, p.projectId ? '▣ ' + projName(p.projectId) : 'global'),
            el('div', { class: 'prompt-preview' }, p.text.slice(0, 100)),
          ),
          el('button', {
            class: 'btn sm',
            onclick: () => {
              editing = p;
              nameIn.value = p.name;
              textIn.value = p.text;
              scopeSel.value = p.projectId || '';
              saveBtn.textContent = 'Update';
            },
          }, '✎'),
          el('button', {
            class: 'btn sm danger',
            onclick: async () => {
              if (!confirm(`Delete prompt "${p.name}"?`)) return;
              try { await api('/api/prompts/' + p.id, { method: 'DELETE' }); refresh(); }
              catch (err) { toast(err.message, true); }
            },
          }, '✕'),
        ))
    );
    if (!prompts.length) listEl.append(el('div', { class: 'hint' }, 'No saved prompts yet — add one below.'));
  }

  const saveBtn = el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        const body = { name: nameIn.value, text: textIn.value, projectId: scopeSel.value || null };
        if (editing) await api('/api/prompts/' + editing.id, { method: 'PUT', body });
        else await api('/api/prompts', { method: 'POST', body });
        editing = null;
        nameIn.value = '';
        textIn.value = '';
        saveBtn.textContent = 'Add prompt';
        refresh();
      } catch (err) { toast(err.message, true); }
    },
  }, 'Add prompt');

  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  },
    el('div', { class: 'modal modal-form' },
      el('div', { class: 'modal-head' },
        el('strong', {}, 'Prompt library'),
        el('button', { class: 'btn sm modal-close', onclick: close }, '✕'),
      ),
      el('div', { class: 'modal-body' },
        listEl,
        el('div', { class: 'field', style: 'margin-top:14px' }, el('label', {}, 'Name'), nameIn),
        el('div', { class: 'field' }, el('label', {}, 'Text'), textIn),
        el('div', { class: 'field' }, el('label', {}, 'Scope'), scopeSel),
      ),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn', onclick: close }, 'Close'),
        saveBtn,
      ),
    ),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  refresh();
}

/* ── Session export ──────────────────────────────────────────────── */

function sessionToMarkdown(agent, s) {
  const lines = [
    `# ${agent.name} — session ${s.cid}`,
    '',
    `- **When**: ${new Date(s.startedAt).toLocaleString()} → ${new Date(s.endedAt).toLocaleString()}`,
    `- **Project**: ${projName(s.pid)}`,
    `- **Runs**: ${s.runs} · **Cost**: ${fmtCost(s.cost, s.estimated, 4)}${s.models.size ? ' · **Model**: ' + [...s.models].join(', ') : ''}`,
    '',
  ];
  for (const ev of s.events) {
    if (ev.type === 'user_prompt') {
      const from = ev.origin && ev.origin.kind !== 'chat' ? ` _(from ${originLabel(ev.origin)})_` : '';
      lines.push(`## 👤 User${from}`, '', ev.text, '');
    } else if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) lines.push(block.text.trim(), '');
        else if (block.type === 'tool_use') lines.push(`> ⚙ **${block.name}** ${toolInputSummary(block.input)}`, '');
      }
    } else if (ev.type === 'result') {
      const cost = typeof ev.total_cost_usd === 'number' ? ` · ${fmtCost(ev.total_cost_usd, ev.estimated_cost_usd, 4)}` : '';
      const dur = ev.duration_ms ? ` · ${(ev.duration_ms / 1000).toFixed(1)}s` : '';
      lines.push(`> ✓ run complete${dur}${cost}`, '');
    } else if (ev.type === 'error') {
      lines.push(`> ✗ ${ev.text}`, '');
    } else if (ev.type === 'meta') {
      lines.push(`> ${ev.text}`, '');
    }
  }
  return lines.join('\n');
}

function downloadSessionMd(agent, s) {
  const md = sessionToMarkdown(agent, s);
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${agent.id}-${s.cid}.md` });
  document.body.append(a);
  a.click();
  a.remove();
}

/* ── Sessions tab ────────────────────────────────────────────────── */

// Group the flat event history into sessions by the server-assigned cid.
function computeSessions(events) {
  const map = new Map();
  for (const ev of events) {
    const cid = ev.cid || 's-0';
    let s = map.get(cid);
    if (!s) {
      s = { cid, pid: null, startedAt: ev.ts, endedAt: ev.ts, events: [], firstPrompt: null, prompts: 0, runs: 0, cost: 0, estimated: 0, models: new Set() };
      map.set(cid, s);
    }
    if (ev.pid !== undefined && ev.pid !== null) s.pid = ev.pid;
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'tool_use' && block.input?.file_path &&
            ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
          (s.filesTouched ||= new Set()).add(block.input.file_path);
        }
      }
    }
    s.events.push(ev);
    s.endedAt = ev.ts;
    if (ev.type === 'user_prompt') {
      s.prompts++;
      if (!s.firstPrompt) {
        s.firstPrompt = ev.text;
        s.origin = ev.origin || null;
      }
    }
    if (ev.type === 'result') {
      s.runs++;
      if (typeof ev.total_cost_usd === 'number') {
        s.cost += ev.total_cost_usd;
        s.estimated += ev.estimated_cost_usd ?? ev.total_cost_usd;
      }
    }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.model) s.models.add(ev.model);
  }
  return [...map.values()].reverse(); // history is chronological → newest first
}

function renderSessions(agent, body) {
  const events = state.histories[agent.id] || [];
  const sessions = computeSessions(events);
  body.dataset.sessCount = String(sessions.length);
  const sel =
    sessions.find((s) => s.cid === state.sessionSel[agent.id]) || sessions[0] || null;
  state.sessionSel[agent.id] = sel?.cid;

  const list = el('div', { class: 'ws-list' });
  const detail = el('div', { class: 'sess-detail' });

  body.replaceChildren(
    el('div', { class: 'ws-wrap' },
      el('div', { class: 'ws-tree' },
        el('div', { class: 'ws-tree-head' },
          el('span', { class: 'crumb' }, `${sessions.length} session${sessions.length === 1 ? '' : 's'}`),
        ),
        list,
      ),
      detail,
    )
  );

  const activeCid = agent.status?.cid || null;
  sessions.forEach((s) => {
    list.append(
      el('div', {
        class: 'sess-entry' + (s === sel ? ' selected' : ''),
        onclick: () => { state.sessionSel[agent.id] = s.cid; renderSessions(agent, body); },
      },
        el('div', { class: 'sess-title' },
          s.cid === activeCid ? el('span', { class: 'sess-badge' }, 'ACTIVE') : null,
          el('span', { class: 'sess-title-text' }, s.firstPrompt || '(no messages yet)'),
        ),
        el('div', { class: 'sess-meta' },
          el('span', { class: 'sess-proj' }, '▣ ' + projName(s.pid)),
          s.origin ? originChip(s.origin, 'sm') : null,
          el('span', {}, new Date(s.startedAt).toLocaleString()),
          el('span', {}, `${s.prompts} msg`),
          el('span', {}, fmtCost(s.cost, s.estimated)),
        ),
      )
    );
  });
  if (!sessions.length) {
    list.append(el('div', { class: 'ws-empty', style: 'padding:24px' }, 'No sessions yet — send a message in Chat'));
  }

  if (sel) renderSessionDetail(agent, sel, detail, sel.cid === activeCid);
  else detail.append(el('div', { class: 'ws-empty' }, 'Select a session'));
}

function renderSessionDetail(agent, s, detail, isActive) {
  const log = el('div', { class: 'chat-log', id: 'sess-log' });
  detail.replaceChildren(
    el('div', { class: 'sess-detail-head' },
      el('span', { class: isActive ? 'sess-live' : null }, isActive ? '● active session' : '○ archived session'),
      s.origin ? originChip(s.origin, 'sm') : null,
      el('span', {}, `${new Date(s.startedAt).toLocaleString()} → ${new Date(s.endedAt).toLocaleTimeString()}`),
      el('span', {}, `${s.prompts} messages`),
      el('span', {}, `${s.runs} runs`),
      el('span', {}, fmtCost(s.cost, s.estimated, 4)),
      s.models.size ? el('span', {}, [...s.models].join(', ')) : null,
      s.filesTouched?.size
        ? el('span', { title: [...s.filesTouched].join('\n') }, `✎ ${s.filesTouched.size} file${s.filesTouched.size === 1 ? '' : 's'}`)
        : null,
      el('span', { class: 'kb-spacer' }),
      el('button', {
        class: 'btn sm', title: 'Copy transcript as Markdown',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(sessionToMarkdown(agent, s));
            toast('Transcript copied as Markdown');
          } catch (err) { toast(err.message, true); }
        },
      }, '⧉ Copy'),
      el('button', {
        class: 'btn sm', title: 'Download transcript as Markdown',
        onclick: () => downloadSessionMd(agent, s),
      }, '⬇ Export'),
    ),
    log,
  );
  for (const ev of s.events) {
    const node = renderEvent(ev);
    if (node) log.append(node);
  }
  log.scrollTop = log.scrollHeight;
}

/* ── Git tab ─────────────────────────────────────────────────────── */

const STATUS_COLORS = { M: 'var(--amber)', A: 'var(--green)', U: 'var(--green)', D: 'var(--red)', R: 'var(--accent)' };

async function renderGit(agent, body) {
  body.replaceChildren(el('div', { class: 'ws-empty' }, 'Reading git status…'));
  let st;
  try {
    st = await api(`/api/instances/${agent.id}/git/status`);
  } catch (err) {
    body.replaceChildren(el('div', { class: 'ws-empty' }, 'Git error: ' + err.message));
    return;
  }

  if (!st.isRepo) {
    body.replaceChildren(
      el('div', { class: 'git-empty' },
        el('div', { class: 'git-empty-icon' }, '⎇'),
        el('div', {}, `${agent.status?.project?.name || 'This workspace'} is not a git repository.`),
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await api(`/api/instances/${agent.id}/git/init`, { method: 'POST', body: {} });
              toast('Repository initialized');
              renderGit(agent, body);
            } catch (err) { toast(err.message, true); }
          },
        }, 'Initialize repository'),
      )
    );
    return;
  }

  let history = [];
  let branchInfo = { branches: [], current: st.branch };
  try {
    [history, branchInfo] = await Promise.all([
      api(`/api/instances/${agent.id}/git/log?limit=15`),
      api(`/api/instances/${agent.id}/git/branches`),
    ]);
  } catch {}

  const refresh = () => renderGit(agent, body);
  const diffPane = el('div', { class: 'git-main' });
  const changesList = el('div', { class: 'git-list' });
  const historyList = el('div', { class: 'git-list' });
  let selectedKey = state.gitSel?.[agent.id] ?? 'all';
  (state.gitSel ||= {})[agent.id] = selectedKey;

  function markSelected() {
    for (const node of [...changesList.children, ...historyList.children]) {
      node.classList.toggle('selected', node.dataset.key === selectedKey);
    }
  }

  async function showDiff(pathOrNull) {
    selectedKey = pathOrNull === null ? 'all' : 'file:' + pathOrNull;
    state.gitSel[agent.id] = selectedKey;
    markSelected();
    diffPane.replaceChildren(el('div', { class: 'ws-empty' }, 'Loading diff…'));
    try {
      const q = pathOrNull ? '?path=' + encodeURIComponent(pathOrNull) : '';
      const data = await api(`/api/instances/${agent.id}/git/diff${q}`);
      diffPane.replaceChildren(
        el('div', { class: 'sess-detail-head' },
          el('span', {}, pathOrNull || 'All uncommitted changes'),
          data.truncated ? el('span', {}, '(truncated)') : null,
        ),
        data.diff.trim() ? renderDiffText(data.diff) : el('div', { class: 'ws-empty' }, 'No changes'),
      );
    } catch (err) {
      diffPane.replaceChildren(el('div', { class: 'ws-empty' }, err.message));
    }
  }

  async function showCommit(hash) {
    selectedKey = 'commit:' + hash;
    state.gitSel[agent.id] = selectedKey;
    markSelected();
    diffPane.replaceChildren(el('div', { class: 'ws-empty' }, 'Loading commit…'));
    try {
      const data = await api(`/api/instances/${agent.id}/git/show?hash=` + hash);
      diffPane.replaceChildren(
        el('div', { class: 'sess-detail-head' },
          el('span', {}, 'commit ' + hash),
          data.truncated ? el('span', {}, '(truncated)') : null,
        ),
        renderDiffText(data.text),
      );
    } catch (err) {
      diffPane.replaceChildren(el('div', { class: 'ws-empty' }, err.message));
    }
  }

  // Branch controls
  const branchSel = el('select', { class: 'hdr-model' },
    ...branchInfo.branches.map((b) =>
      el('option', { value: b, selected: b === branchInfo.current ? '' : null }, '⎇ ' + b)),
  );
  if (branchInfo.current && !branchInfo.branches.includes(branchInfo.current)) {
    branchSel.prepend(el('option', { value: branchInfo.current, selected: '' }, '⎇ ' + branchInfo.current));
  }
  branchSel.onchange = async () => {
    try {
      await api(`/api/instances/${agent.id}/git/checkout`, { method: 'POST', body: { name: branchSel.value } });
      toast('Switched to ' + branchSel.value);
      refresh();
    } catch (err) { toast(err.message, true); refresh(); }
  };

  const commitMsg = el('textarea', { class: 'commit-msg', rows: '2', placeholder: 'Commit message…' });
  const commitBtn = el('button', {
    class: 'btn primary sm',
    disabled: st.changes.length ? null : '',
    onclick: async () => {
      try {
        const r = await api(`/api/instances/${agent.id}/git/commit`, { method: 'POST', body: { message: commitMsg.value } });
        toast(`Committed ${r.hash}`);
        refresh();
      } catch (err) { toast(err.message, true); }
    },
  }, `Commit all (${st.changes.length})`);

  body.replaceChildren(
    el('div', { class: 'ws-wrap' },
      el('div', { class: 'git-side' },
        el('div', { class: 'git-toolbar' },
          branchSel,
          el('button', {
            class: 'btn sm', title: 'New branch',
            onclick: async () => {
              const name = prompt('New branch name:');
              if (!name) return;
              try {
                await api(`/api/instances/${agent.id}/git/branch`, { method: 'POST', body: { name } });
                toast('Created branch ' + name);
                refresh();
              } catch (err) { toast(err.message, true); }
            },
          }, '+'),
          el('button', { class: 'btn sm', title: 'Refresh', onclick: refresh }, '↻'),
        ),
        st.ahead || st.behind
          ? el('div', { class: 'git-sync' }, `${st.ahead ? '↑' + st.ahead + ' ahead ' : ''}${st.behind ? '↓' + st.behind + ' behind' : ''}`)
          : null,
        el('div', { class: 'git-section-title' }, `CHANGES — ${st.changes.length}`),
        changesList,
        st.changes.length
          ? el('div', { class: 'commit-box' }, commitMsg, commitBtn)
          : null,
        el('div', { class: 'git-section-title' }, 'HISTORY'),
        historyList,
      ),
      diffPane,
    )
  );

  if (st.changes.length) {
    changesList.append(
      el('div', { class: 'ws-entry', 'data-key': 'all', onclick: () => showDiff(null) },
        el('span', {}, '∑'), el('span', { class: 'name' }, 'All changes')),
    );
  }
  for (const change of st.changes) {
    changesList.append(
      el('div', { class: 'ws-entry', 'data-key': 'file:' + change.path, onclick: () => showDiff(change.path) },
        el('span', { class: 'git-st', style: `color:${STATUS_COLORS[change.status] || 'var(--text-dim)'}` }, change.status),
        el('span', { class: 'name', title: change.path }, change.path),
        el('button', {
          class: 'btn sm', title: 'Discard changes',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Discard changes to ${change.path}?${change.untracked ? '\n(This deletes the untracked file.)' : ''}`)) return;
            try {
              await api(`/api/instances/${agent.id}/git/discard`, { method: 'POST', body: { path: change.path } });
              toast('Discarded ' + change.path);
              refresh();
            } catch (err) { toast(err.message, true); }
          },
        }, '↩'),
      ),
    );
  }
  if (!st.changes.length) {
    changesList.append(el('div', { class: 'ws-entry' }, el('span', { class: 'name' }, 'working tree clean ✓')));
  }
  for (const commit of history) {
    historyList.append(
      el('div', { class: 'ws-entry', 'data-key': 'commit:' + commit.hash, onclick: () => showCommit(commit.hash) },
        el('span', { class: 'git-hash' }, commit.hash),
        el('span', { class: 'name', title: `${commit.subject} — ${commit.author}` }, commit.subject),
        el('span', { class: 'size' }, commit.when),
      ),
    );
  }
  if (!history.length) {
    historyList.append(el('div', { class: 'ws-entry' }, el('span', { class: 'name' }, 'no commits yet')));
  }

  // Restore previous selection, defaulting to the full diff.
  if (selectedKey.startsWith('commit:')) showCommit(selectedKey.slice(7));
  else if (selectedKey.startsWith('file:') && st.changes.some((c) => 'file:' + c.path === selectedKey)) showDiff(selectedKey.slice(5));
  else showDiff(null);
}

function renderDiffText(text) {
  const pre = el('pre', { class: 'diff-view' });
  for (const line of text.split('\n')) {
    const div = el('div', { class: 'diff-line' });
    if (line.startsWith('+') && !line.startsWith('+++')) div.classList.add('add');
    else if (line.startsWith('-') && !line.startsWith('---')) div.classList.add('del');
    else if (line.startsWith('@@')) div.classList.add('hunk');
    else if (/^(diff |index |\+\+\+|---|new file|deleted file|rename |commit |Author:|Date:)/.test(line)) div.classList.add('fhead');
    div.textContent = line || ' ';
    pre.append(div);
  }
  return pre;
}

/* ── Workspace tab ───────────────────────────────────────────────── */

/* ── File tree ───────────────────────────────────────────────────── */

// Lazy folder tree over the agent's current workspace (the project root when
// one is selected). Folders expand in place and remember their state per
// agent. Every row is draggable onto the chat composer (payload: REF_MIME with
// the absolute path) and shows a "+" on hover that stages it without dragging.
function fileTree(agent, { onOpen, onAdd } = {}) {
  const ft = (state.fileTree[agent.id] ||= { expanded: new Set(), root: null, selected: null });
  const box = el('div', { class: 'ftree' });

  const absOf = (rel) => (ft.root ? ft.root + (rel ? '/' + rel : '') : rel);
  const refOf = (entry) => ({ name: entry.name, path: absOf(entry.path), rel: entry.path, type: entry.type });
  const note = (depth, text) =>
    el('div', { class: 'ftree-note', style: `padding-left:${18 + depth * 14}px` }, text);

  async function fill(rel, depth, into) {
    let data;
    try {
      data = await api(`/api/instances/${agent.id}/files?path=${encodeURIComponent(rel)}`);
    } catch (err) {
      into.replaceChildren(note(depth, err.message));
      return;
    }
    ft.root = data.root || agent.status?.project?.path || ft.root;
    into.replaceChildren(...data.entries.map((entry) => node(entry, depth)));
    if (!data.entries.length) into.append(note(depth, '(empty)'));
  }

  function node(entry, depth) {
    const isDir = entry.type === 'dir';
    const children = el('div', { class: 'ftree-children' });
    const caret = el('span', { class: 'ftree-caret' }, isDir ? '▸' : '');
    const dim = entry.name.startsWith('.') || entry.name === 'node_modules';
    const row = el('div', {
      class: 'ftree-row' + (dim ? ' dim' : '') + (entry.path === ft.selected ? ' selected' : ''),
      draggable: 'true',
      'data-path': entry.path,
      title: entry.path,
      style: `padding-left:${8 + depth * 14}px`,
    },
      caret,
      el('span', { class: 'ftree-icon' }, isDir ? '📁' : '📄'),
      el('span', { class: 'name' }, entry.name),
      isDir ? null : el('span', { class: 'size' }, fmtBytes(entry.size)),
      onAdd ? el('button', {
        class: 'ftree-add', title: 'Add to the chat message',
        onclick: (e) => { e.stopPropagation(); onAdd(refOf(entry)); },
      }, '+') : null,
    );
    const setOpen = (open) => {
      caret.textContent = open ? '▾' : '▸';
      children.style.display = open ? '' : 'none';
      if (open) ft.expanded.add(entry.path);
      else ft.expanded.delete(entry.path);
      if (open && !children.childElementCount) fill(entry.path, depth + 1, children);
    };
    row.addEventListener('click', () => {
      if (isDir) setOpen(!ft.expanded.has(entry.path));
      else if (onOpen) onOpen(entry);
    });
    row.addEventListener('dragstart', (e) => {
      const ref = refOf(entry);
      e.dataTransfer.setData(REF_MIME, JSON.stringify(ref));
      e.dataTransfer.setData('text/plain', ref.path);
      e.dataTransfer.effectAllowed = 'copy';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    if (isDir) setOpen(ft.expanded.has(entry.path));
    else children.style.display = 'none';
    return el('div', { class: 'ftree-node' }, row, children);
  }

  box.reload = () => fill('', 0, box);
  box.select = (rel) => {
    ft.selected = rel;
    for (const r of box.querySelectorAll('.ftree-row')) r.classList.toggle('selected', r.dataset.path === rel);
  };
  box.absOf = absOf;
  box.reload();
  return box;
}

/* ── Workspace tab ───────────────────────────────────────────────── */

function renderWorkspace(agent, body) {
  const ws = (state.wsFile[agent.id] ||= { dir: '', selected: null });
  const proj = agent.status?.project;
  const editorPane = el('div', { class: 'ws-editor', id: 'ws-editor' });
  const tree = fileTree(agent, {
    onOpen: (entry) => openFile(entry.path),
    onAdd: (ref) => {
      if (stageRef(agent, ref)) toast(`Added ${ref.name} to the chat message`);
    },
  });

  body.replaceChildren(
    el('div', { class: 'ws-wrap' },
      el('div', { class: 'ws-tree' },
        el('div', { class: 'ws-tree-head' },
          el('span', { class: 'crumb', title: proj?.path || 'agent workspace' }, proj ? proj.name : 'workspace'),
          el('button', { class: 'btn sm', onclick: () => tree.reload(), title: 'Refresh' }, '↻'),
          el('button', {
            class: 'btn sm', title: 'New file',
            onclick: async () => {
              const name = prompt('New file path (relative to workspace):');
              if (!name) return;
              try {
                await api(`/api/instances/${agent.id}/file`, { method: 'PUT', body: { path: name, content: '' } });
                await tree.reload();
                openFile(name);
              } catch (err) { toast(err.message, true); }
            },
          }, '+'),
        ),
        el('div', { class: 'ws-tree-hint' }, 'Drag a file or folder into the chat, or hover a row and press +'),
        tree,
      ),
      editorPane,
    )
  );

  if (ws.selected) openFile(ws.selected);
  else showEmptyEditor();

  function showEmptyEditor() {
    editorPane.replaceChildren(
      el('div', { class: 'ws-empty' }, 'Select a file to view or edit')
    );
  }

  async function openFile(relPath) {
    ws.selected = relPath;
    tree.select(relPath);
    let data;
    try {
      data = await api(`/api/instances/${agent.id}/file?path=${encodeURIComponent(relPath)}`);
    } catch (err) {
      toast(err.message, true);
      ws.selected = null;
      tree.select(null);
      showEmptyEditor();
      return;
    }
    const askBtn = el('button', {
      class: 'btn sm', title: 'Add this file to the chat message and switch to Chat',
      onclick: () => {
        stageRef(agent, { name: relPath.split('/').pop(), path: tree.absOf(relPath), type: 'file' });
        state.tab = 'chat';
        renderAgentPage(agent);
      },
    }, '💬 Ask in chat');
    if (data.binary) {
      editorPane.replaceChildren(
        el('div', { class: 'ws-editor-head' }, el('span', { class: 'fname' }, relPath), askBtn),
        el('div', { class: 'ws-empty' }, `Binary file · ${fmtBytes(data.size)}`),
      );
      return;
    }
    const ta = el('textarea', { spellcheck: 'false' });
    ta.value = data.content;
    const saveBtn = el('button', {
      class: 'btn sm primary',
      onclick: async () => {
        try {
          await api(`/api/instances/${agent.id}/file`, {
            method: 'PUT',
            body: { path: relPath, content: ta.value },
          });
          toast('Saved ' + relPath);
        } catch (err) { toast(err.message, true); }
      },
    }, 'Save');
    editorPane.replaceChildren(
      el('div', { class: 'ws-editor-head' },
        el('span', { class: 'fname' }, relPath),
        data.truncated ? el('span', {}, `(showing first ${fmtBytes(500 * 1024)})`) : null,
        askBtn,
        saveBtn,
      ),
      ta,
    );
  }
}

/* ── Control room tab ────────────────────────────────────────────── */

async function renderControl(agent, body) {
  let settings;
  try {
    settings = await api(`/api/instances/${agent.id}/settings`);
  } catch {
    settings = { schema: [], values: {} };
  }

  const fields = settings.schema.map((field) => {
    const saveValue = async (value) => {
      try {
        await api(`/api/instances/${agent.id}/settings`, { method: 'PUT', body: { [field.key]: value } });
        toast(`${field.label} updated`);
      } catch (err) { toast(err.message, true); }
    };
    let input;
    if (field.type === 'text') {
      input = el('input', { placeholder: field.placeholder || '' });
      input.value = settings.values[field.key] ?? '';
      input.addEventListener('change', () => saveValue(input.value.trim()));
    } else {
      input = el('select', { onchange: () => saveValue(input.value) },
        (field.options || []).map((opt) =>
          el('option', { value: opt.value, selected: settings.values[field.key] === opt.value ? '' : null }, opt.label)
        )
      );
    }
    return el('div', { class: 'field' }, el('label', {}, field.label), input);
  });

  const logPane = el('div', { class: 'log-pane', id: 'ctl-log' });

  body.replaceChildren(
    el('div', { class: 'control-wrap' },
      el('div', { class: 'control-grid' },
        el('div', { class: 'panel' },
          el('h3', {}, 'Configuration'),
          el('div', { class: 'hint' }, 'Overrides for this instance; new instances start from the agent\'s defaults.'),
          fields.length ? fields : el('div', { class: 'ws-empty' }, 'No settings for this adapter'),
        ),
        el('div', { class: 'panel' },
          el('h3', {}, 'Session'),
          el('div', { id: 'ctl-info' }),
          el('div', { class: 'btn-row', style: 'margin-top:14px' },
            el('button', {
              class: 'btn danger',
              onclick: () => api(`/api/instances/${agent.id}/stop`, { method: 'POST' })
                .then(() => toast('Abort signal sent'))
                .catch((e) => toast(e.message, true)),
            }, 'Abort current run'),
            el('button', {
              class: 'btn',
              onclick: () => api(`/api/instances/${agent.id}/session/clear`, { method: 'POST' })
                .then(() => toast('Session cleared'))
                .catch((e) => toast(e.message, true)),
            }, 'New session'),
            el('button', {
              class: 'btn',
              onclick: () => {
                if (!confirm('Delete this instance\'s conversations from the project history?')) return;
                api(`/api/instances/${agent.id}/history/clear`, { method: 'POST' })
                  .then(() => toast('History cleared'))
                  .catch((e) => toast(e.message, true));
              },
            }, 'Clear history'),
            el('button', {
              class: 'btn danger',
              disabled: agent.status?.state === 'working' ? '' : null,
              title: agent.status?.state === 'working' ? 'Abort the run or wait for it to finish first' : 'Close this instance; its conversations stay in the project history',
              onclick: () => {
                if (!confirm(`Close "${agent.name}"?\nIts conversations stay in ${projName(agent.projectId)}'s history.`)) return;
                closeInstance(agent);
              },
            }, 'Close instance'),
          ),
        ),
        el('div', { class: 'panel span2' },
          el('h3', {}, 'Telemetry — raw event stream'),
          logPane,
        ),
      ),
    )
  );

  refreshControlInfo(agent);

  const events = state.histories[agent.id] || [];
  for (const ev of events.slice(-200)) appendLogLine(ev);
  logPane.scrollTop = logPane.scrollHeight;
}

function refreshControlInfo(agent) {
  const info = $('#ctl-info');
  if (!info) return;
  const st = agent.status || {};
  info.replaceChildren(
    kv('Agent', agent.agent || agent.agentId),
    kv('Project', st.project?.name || projName(agent.projectId)),
    kv('State', st.state || 'offline'),
    kv('Model', modelLabel(st)),
    kv('Session ID', st.sessionId ? st.sessionId.slice(0, 18) + '…' : 'none (fresh)'),
    kv('Runs', String(st.totals?.runs ?? 0)),
    kv('Session cost', fmtCost(st.totals?.cost, st.totals?.estimated, 4)),
    kv('Last activity', fmtAgo(st.lastActivity)),
  );
}

function kv(k, v) {
  return el('div', { class: 'kv' }, el('span', { class: 'k' }, k), el('span', { class: 'v' }, v));
}

function appendLogLine(ev) {
  const pane = $('#ctl-log');
  if (!pane) return;
  const time = new Date(ev.ts || Date.now()).toLocaleTimeString();
  const line = el('div', {},
    el('span', { class: 'lt' }, `[${time}] ${ev.type}${ev.subtype ? '/' + ev.subtype : ''} `),
    JSON.stringify(ev).slice(0, 400),
  );
  pane.append(line);
  while (pane.childNodes.length > 300) pane.removeChild(pane.firstChild);
  pane.scrollTop = pane.scrollHeight;
}

/* ── Clock + boot ────────────────────────────────────────────────── */

setInterval(() => {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString('en-GB');
}, 1000);

// Keep the live CLI sessions panel fresh while the home page is visible.
setInterval(() => {
  if ($('#cli-live-list')) refreshCliSessions();
}, 15000);

// Keep the Vault page fresh while it's visible — writes also arrive from MCP
// servers in other agent processes, so nothing pushes updates to us. The
// editor pane is deliberately left alone. A not-yet-ready vault re-renders
// the whole page so it picks up the moment initialization finishes.
setInterval(() => {
  if ($('#vault-feed-list')) { refreshVaultTree(); refreshVaultFeed(); }
  else if ($('#vault-retry')) renderVault();
}, 20000);

(async function boot() {
  try {
    [state.agents, state.instances, state.projects] = await Promise.all([
      api('/api/agents'),
      api('/api/instances'),
      api('/api/projects'),
    ]);
  } catch (err) {
    toast('Failed to reach server: ' + err.message, true);
  }
  renderSidebar();
  route();
  connectWS();
})();
