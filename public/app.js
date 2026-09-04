/* Mission Control — frontend */
'use strict';

const state = {
  agents: [],            // [{id, name, description, accent, status}]
  projects: [],          // [{id, name, path, description, agents}]
  tasks: [],             // kanban cards
  boardProj: undefined,  // selected board project id (null = default workspace)
  histories: {},         // agentId -> [events]
  tab: 'chat',           // active tab on agent pages
  wsFile: {},            // agentId -> { dir, selected, dirty }
  fileTree: {},          // agentId -> { expanded:Set, root, selected } (file trees)
  attach: {},            // agentId -> staged uploads / file references for the next message
  drafts: {},            // agentId -> unsent composer text, survives agent switches
  skillsCache: {},       // agentId -> { at, items } for the composer's `/` picker
  sessionSel: {},        // agentId -> selected session cid
  agentProj: {},         // agentId -> last seen project id (change detection)
  agentCid: {},          // agentId -> last seen conversation id
  projEdit: null,        // project id currently being edited on Projects page
  voice: null,           // active voice session (M16): recorder or dictation, one at a time
  voiceCfg: null,        // { at, whisperKey } cache for the 🎤 picker
  vault: null,           // Vault page: { sel, editing, draft, q, flaggedOnly, expanded:Set }
  cliSessions: [],       // live external CLI sessions (from /api/cli-sessions)
  cliFetchedAt: 0,
  fleet: null,           // Fleet page (M17): { rows, windowMs, types, data, sel }
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
    if (!cur && !onOtherPage()) renderHome();
    return;
  }
  if (msg.type === 'projects') {
    state.projects = msg.projects;
    if (onProjectsPage()) renderProjects();
    else if (!currentAgentId()) { if (!onOtherPage()) renderHome(); }
    else {
      const agent = getAgent(currentAgentId());
      if (agent) populateProjectSelect(agent);
    }
    return;
  }
  if (msg.type === 'agent_partial') {
    if (currentAgentId() === msg.agentId && state.tab === 'chat') updatePartialBubble(msg.text);
    return;
  }
  if (msg.type === 'agent_status') {
    const agent = getAgent(msg.agentId);
    if (agent) agent.status = msg.status;
    renderSidebar();
    onStatusChanged(msg.agentId);
    return;
  }
  if (msg.type === 'agent_event') {
    (state.histories[msg.agentId] ||= []).push(msg.event);
    if (onAnalyticsPage()) {
      clearTimeout(state.anTimer);
      state.anTimer = setTimeout(renderAnalytics, 700);
      return;
    }
    if (onFleetPage()) {
      scheduleFleetRefresh();
      return;
    }
    onAgentEvent(msg.agentId, msg.event);
    return;
  }
  if (msg.type === 'history_cleared') {
    state.histories[msg.agentId] = [];
    if (currentAgentId() === msg.agentId) route();
  }
}

/* ── Routing ─────────────────────────────────────────────────────── */

function currentAgentId() {
  const m = location.hash.match(/^#\/agent\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function onProjectsPage() {
  return location.hash.startsWith('#/projects');
}

function currentProjectHistoryId() {
  const m = location.hash.match(/^#\/project\/([^/]+)/);
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

function onFleetPage() {
  return location.hash.startsWith('#/fleet');
}

// True on any route that isn't the agent view or the home dashboard, so
// background broadcasts (agent/project list updates) don't yank the user
// back to the dashboard while they're looking at one of these pages.
function onOtherPage() {
  return onProjectsPage() || onBoardPage() || onAlertsPage() || onAnalyticsPage() || onVaultPage() || onFleetPage() || !!currentProjectHistoryId();
}

async function route() {
  const id = currentAgentId();
  renderSidebar();
  if (onProjectsPage()) return renderProjects();
  if (currentProjectHistoryId()) return renderProjectHistory(currentProjectHistoryId());
  if (onBoardPage()) return renderBoard();
  if (onAlertsPage()) return renderAlerts();
  if (onAnalyticsPage()) return renderAnalytics();
  if (onVaultPage()) return renderVault();
  if (onFleetPage()) return renderFleet();
  if (!id) return renderHome();
  const agent = getAgent(id);
  if (!agent) return renderHome();
  if (!state.histories[id]) {
    try { state.histories[id] = await api(`/api/agents/${id}/history`); }
    catch { state.histories[id] = []; }
  }
  renderAgentPage(agent);
}

window.addEventListener('hashchange', route);

/* ── Sidebar ─────────────────────────────────────────────────────── */

function renderSidebar() {
  const id = currentAgentId();
  $('.nav-item[data-route="home"]').classList.toggle('active', !id && !onProjectsPage() && !onBoardPage() && !onAlertsPage() && !onAnalyticsPage() && !onVaultPage() && !onFleetPage());
  $('.nav-item[data-route="fleet"]').classList.toggle('active', onFleetPage());
  $('.nav-item[data-route="projects"]').classList.toggle('active', onProjectsPage() || !!currentProjectHistoryId());
  $('.nav-item[data-route="board"]').classList.toggle('active', onBoardPage());
  $('.nav-item[data-route="alerts"]').classList.toggle('active', onAlertsPage());
  $('.nav-item[data-route="analytics"]').classList.toggle('active', onAnalyticsPage());
  $('.nav-item[data-route="vault"]').classList.toggle('active', onVaultPage());
  const nav = $('#agent-nav');
  nav.replaceChildren(
    ...state.agents.map((a) =>
      el('a', {
        class: 'nav-item' + (a.id === id ? ' active' : ''),
        href: `#/agent/${encodeURIComponent(a.id)}`,
      },
        el('span', { class: `dot ${a.status?.state || 'offline'}` }),
        el('span', { class: 'nav-agent-col' },
          el('span', { class: 'nav-agent-name' }, a.name),
          el('span', { class: 'nav-agent-model' }, modelLabel(a.status)),
        ),
        a.status?.queue?.length
          ? el('span', { class: 'nav-queue-badge', title: 'queued tasks' }, String(a.status.queue.length))
          : null,
      )
    )
  );
  nav.append(
    el('button', { class: 'nav-item nav-add', onclick: openNewAgentModal },
      el('span', { class: 'nav-icon' }, '+'), 'New agent')
  );
}

/* ── New agent modal ─────────────────────────────────────────────── */

async function openNewAgentModal() {
  let types = [];
  try {
    types = await api('/api/agent-types');
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const nameIn = el('input', { placeholder: 'e.g. Claude Code — API work' });
  const typeSel = el('select', {}, types.map((t) => el('option', { value: t.type }, t.label)));
  const descIn = el('input', { placeholder: 'Description (optional)' });

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  async function create() {
    try {
      const created = await api('/api/agents', {
        method: 'POST',
        body: { name: nameIn.value, type: typeSel.value, description: descIn.value },
      });
      close();
      toast(`Agent "${created.name}" is online`);
      location.hash = '#/agent/' + encodeURIComponent(created.id);
    } catch (err) {
      toast(err.message, true);
    }
  }

  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (e.target === overlay) close(); },
  },
    el('div', { class: 'modal modal-form' },
      el('div', { class: 'modal-head' },
        el('strong', {}, 'New agent'),
        el('button', { class: 'btn sm modal-close', onclick: close }, '✕'),
      ),
      el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', {}, 'Name'), nameIn),
        el('div', { class: 'field' }, el('label', {}, 'Type'), typeSel),
        el('div', { class: 'field' }, el('label', {}, 'Description'), descIn),
      ),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn', onclick: close }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: create }, 'Create agent'),
      ),
    ),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  nameIn.focus();
}

/* ── Home / overview ─────────────────────────────────────────────── */

function renderHome() {
  const online = state.agents.filter((a) => a.status?.state !== 'offline').length;
  const working = state.agents.filter((a) => a.status?.state === 'working').length;
  const cost = state.agents.reduce((s, a) => s + (a.status?.totals?.cost || 0), 0);
  const est = state.agents.reduce((s, a) => s + (a.status?.totals?.estimated ?? a.status?.totals?.cost ?? 0), 0);

  main.replaceChildren(
    el('div', { class: 'page' },
      el('div', { class: 'home-head' },
        el('div', {},
          el('h1', { class: 'page-title' }, 'MISSION CONTROL'),
          el('p', { class: 'page-sub' }, 'Live status of every agent in the fleet.'),
        ),
        el('a', { class: 'btn primary sm', href: '#/fleet' }, '⁂ Launch fleet'),
      ),
      el('div', { class: 'stats' },
        statTile(state.agents.length, 'Agents registered'),
        statTile(online, 'Online', online > 0 ? 'var(--green)' : null),
        statTile(working, 'Active tasks', working > 0 ? 'var(--amber)' : null),
        el('div', { class: 'stat' },
          el('div', {
            class: 'stat-value', id: 'cli-live-count',
            style: cliOpenCount() ? 'color:var(--green)' : null,
          }, String(cliOpenCount())),
          el('div', { class: 'stat-label' }, 'CLI tabs open'),
        ),
        statTile(fmtCost(cost, est), 'Session spend'),
      ),
      el('div', { class: 'panel cli-live-panel' },
        el('h3', {}, 'Live CLI sessions'),
        el('div', { id: 'cli-live-list' }, cliLiveRows()),
      ),
      el('div', { class: 'agent-grid' },
        state.agents.map(agentCard),
        el('button', { class: 'agent-card add-card', onclick: openNewAgentModal },
          el('span', { class: 'add-card-plus' }, '+'),
          el('span', {}, 'Add agent'),
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

/* ── Fleet launch + timeline (M17) ───────────────────────────────── */

// Chart ink for the timeline: the UI accent colours are too light for data
// marks on the dark panels, so bars wear these darker same-hue twins. The
// mapping keeps colour following the entity (an agent's bar is always its own
// accent's hue) and the set is validated for the dark surface (OKLCH L band,
// chroma, CVD and normal-vision separation, 3:1 contrast).
const FLEET_CHART_COLORS = {
  '#d97757': '#cf5c30',
  '#5eb0ff': '#4a90e2',
  '#34d399': '#17a673',
  '#fbbf24': '#b5860d',
  '#c084fc': '#9d5ce0',
  '#f472b6': '#d94f8a',
};

function fleetChartColor(accent) {
  return FLEET_CHART_COLORS[String(accent || '').toLowerCase()] || '#4a90e2';
}

const FLEET_WINDOWS = [
  { label: 'Last hour', ms: 3600e3 },
  { label: 'Last 6 hours', ms: 6 * 3600e3 },
  { label: 'Last 24 hours', ms: 24 * 3600e3 },
  { label: 'Last 7 days', ms: 7 * 864e5 },
];

function fleetEmptyRow() {
  return { projectId: '', type: 'claude-code', prompt: '' };
}

function fleetState() {
  // Composer rows and the selected window live in state so WS-driven
  // re-renders of the timeline never eat what's being typed.
  if (!state.fleet) {
    state.fleet = {
      rows: [fleetEmptyRow()],
      windowMs: 6 * 3600e3,
      types: null,   // cached /api/agent-types
      data: null,    // last /api/fleet/timeline response
      sel: null,     // selected bar key `${agentId}:${start}`
    };
  }
  return state.fleet;
}

// The stat tiles are patched on every timeline refresh (new runs land, agents
// get spawned by launches) rather than only on the page's first render.
function fleetStats() {
  const lanes = state.fleet?.data?.lanes || [];
  return {
    running: lanes.filter((l) => l.runs.some((r) => r.running)).length,
    agents: state.agents.length,
    inWindow: lanes.reduce((s, l) => s + l.runs.filter((r) => !r.running).length, 0),
    queued: state.agents.reduce((s, a) => s + (a.status?.queue?.length || 0), 0),
  };
}

function fleetStatTile(key, value, label, color) {
  const tile = statTile(value, label, color);
  tile.querySelector('.stat-value').id = 'fleet-stat-' + key;
  return tile;
}

function updateFleetStats() {
  const s = fleetStats();
  const set = (key, text, color) => {
    const node = $('#fleet-stat-' + key);
    if (node) { node.textContent = text; node.style.color = color || ''; }
  };
  set('running', String(s.running), s.running > 0 ? 'var(--green)' : '');
  set('agents', String(s.agents));
  set('runs', String(s.inWindow));
  set('queued', String(s.queued), s.queued > 0 ? 'var(--amber)' : '');
}

async function renderFleet() {
  const f = fleetState();
  if (!f.types) {
    try { f.types = await api('/api/agent-types'); } catch { f.types = []; }
  }
  const s = fleetStats();

  main.replaceChildren(
    el('div', { class: 'page' },
      el('h1', { class: 'page-title' }, 'FLEET'),
      el('p', { class: 'page-sub' }, 'Start several agents at once — one per workspace — and watch every run across the fleet.'),
      el('div', { class: 'stats' },
        fleetStatTile('running', s.running, 'Running now', s.running > 0 ? 'var(--green)' : null),
        fleetStatTile('agents', s.agents, 'Agents'),
        fleetStatTile('runs', s.inWindow, 'Runs in window'),
        fleetStatTile('queued', s.queued, 'Queued tasks', s.queued > 0 ? 'var(--amber)' : null),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, 'Launch agents'),
        el('div', { class: 'fleet-hint' },
          'Each row claims an idle agent of its type — reusing one already in that workspace, repointing a free one, or spawning a fresh agent — so every row runs concurrently.'),
        el('div', { id: 'fleet-rows' }, ...f.rows.map((row, i) => fleetRow(f, row, i))),
        el('div', { class: 'fleet-composer-foot' },
          el('button', {
            class: 'btn sm',
            onclick: () => { f.rows.push(fleetEmptyRow()); $('#fleet-rows').append(fleetRow(f, f.rows[f.rows.length - 1], f.rows.length - 1)); },
          }, '+ Add agent'),
          el('button', { class: 'btn primary', onclick: launchFleetRows }, 'Launch agents'),
          el('span', { class: 'fleet-note' }, 'Idle agents are reused before new ones are spawned.'),
        ),
      ),
      el('div', { class: 'panel' },
        el('div', { class: 'fleet-tl-head' },
          el('h3', {}, 'Runs across the fleet'),
          el('div', { class: 'fleet-legend' },
            el('span', { class: 'fleet-leg-item', title: 'A completed run, in its agent\'s colour' },
              el('span', { class: 'fleet-leg-swatch done' }), 'run'),
            el('span', { class: 'fleet-leg-item' }, el('span', { class: 'fleet-leg-swatch failed' }), 'failed'),
            el('span', { class: 'fleet-leg-item', title: 'In flight — the bar grows until the run ends' },
              el('span', { class: 'fleet-leg-swatch running' }), 'running'),
          ),
          el('select', {
            class: 'hdr-model',
            onchange: (e) => { f.windowMs = +e.target.value; f.data = null; refreshFleetTimeline(); },
          }, FLEET_WINDOWS.map((w) => el('option', {
            value: String(w.ms),
            selected: w.ms === f.windowMs ? '' : null,
          }, w.label))),
        ),
        el('div', { id: 'fleet-tl' }, el('div', { class: 'fleet-empty' }, 'Loading timeline…')),
        el('div', { id: 'fleet-detail' }),
      ),
    )
  );
  refreshFleetTimeline();
}

function fleetRow(f, row, i) {
  const typeOptions = (f.types || []).some((t) => t.type === row.type) ? f.types : [{ type: row.type, label: row.type }, ...(f.types || [])];
  return el('div', { class: 'fleet-row' },
    el('select', {
      class: 'hdr-model fleet-row-proj', title: 'Where this agent works',
      onchange: (e) => { row.projectId = e.target.value; },
    },
      el('option', { value: '' }, 'Own workspace'),
      state.projects.map((p) => el('option', {
        value: p.id, selected: p.id === row.projectId ? '' : null,
      }, p.name)),
    ),
    el('select', {
      class: 'hdr-model fleet-row-type', title: 'Agent type',
      onchange: (e) => { row.type = e.target.value; },
    }, typeOptions.map((t) => el('option', {
      value: t.type, selected: t.type === row.type ? '' : null,
    }, t.label))),
    el('input', {
      class: 'fleet-row-prompt', placeholder: 'Prompt for this agent…', value: row.prompt,
      oninput: (e) => { row.prompt = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') launchFleetRows(); },
    }),
    el('button', {
      class: 'btn sm danger fleet-row-x', title: 'Remove this row',
      onclick: () => {
        f.rows.splice(f.rows.indexOf(row), 1);
        if (!f.rows.length) f.rows.push(fleetEmptyRow());
        renderFleet();
      },
    }, '✕'),
  );
}

async function launchFleetRows() {
  const f = fleetState();
  const rows = f.rows.filter((r) => r.prompt.trim());
  if (!rows.length) return toast('Add at least one prompt to launch', true);
  if (rows.length < f.rows.length) {
    toast(`${f.rows.length - rows.length} row(s) without a prompt were skipped`, true);
  }
  try {
    const res = await api('/api/fleet/launch', {
      method: 'POST',
      body: { rows: rows.map((r) => ({ projectId: r.projectId || null, type: r.type, prompt: r.prompt.trim() })) },
    });
    const modes = res.launched.map((l) => `${l.agentName} (${l.mode})`).join(' · ');
    toast(`Launched ${res.launched.length} agent${res.launched.length === 1 ? '' : 's'} — ${modes}`);
    f.rows = [fleetEmptyRow()];
    f.sel = null;
    renderFleet();
  } catch (err) {
    toast(err.message, true);
  }
}

// Timeline refresh cadence: agent events/status changes debounce a refetch,
// and a slow interval keeps running bars growing even when a run goes quiet.
let fleetRefreshTimer = null;

function scheduleFleetRefresh() {
  if (!onFleetPage()) return;
  clearTimeout(fleetRefreshTimer);
  fleetRefreshTimer = setTimeout(refreshFleetTimeline, 1500);
}

async function refreshFleetTimeline() {
  if (!onFleetPage()) return;
  const f = fleetState();
  let data;
  try {
    data = await api(`/api/fleet/timeline?window=${f.windowMs}`);
  } catch {
    return;
  }
  if (!onFleetPage()) return; // user navigated away mid-fetch
  f.data = data;
  drawFleetTimeline();
}

// A "nice" axis step: the smallest round step that gives ~6 ticks.
function fleetNiceStep(rangeMs) {
  const steps = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 864e5];
  const target = rangeMs / 6;
  for (const s of steps) if (s >= target) return s;
  return 864e5;
}

function fleetTickLabel(ts, step) {
  const d = new Date(ts);
  if (step >= 864e5) {
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Position math is frozen to the fetched {since, now} so bars stay put between
// refetches; the running bar's width and the gutter clocks advance on refresh.
function drawFleetTimeline() {
  const wrap = $('#fleet-tl');
  if (!wrap) return;
  const f = fleetState();
  const data = f.data;
  if (!data) return;
  const range = Math.max(1, data.now - data.since);
  const pct = (ts) => Math.min(100, Math.max(0, ((ts - data.since) / range) * 100));
  const step = fleetNiceStep(range);
  const ticks = [];
  for (let t = Math.ceil(data.since / step) * step; t <= data.now; t += step) ticks.push(t);

  const gridlines = el('div', { class: 'fleet-gridlines' },
    ticks.map((t) => el('div', { class: 'fleet-gline', style: `left:${pct(t)}%` })));

  const lanes = data.lanes.map((lane) => {
    const color = fleetChartColor(lane.accent);
    const isRunning = lane.runs.some((r) => r.running);
    const bars = lane.runs.map((run) => {
      const left = pct(run.start);
      const right = pct(Math.min(run.running ? data.now : run.end, data.now));
      // Short runs get a visible sliver, pulled back inside the right edge.
      const width = Math.max(right - left, 0.35);
      const key = `${lane.id}:${run.start}`;
      return el('button', {
        class: 'fleet-bar' + (run.running ? ' running' : '') + (run.failed ? ' failed' : '') + (f.sel === key ? ' selected' : ''),
        style: `left:${Math.min(left, 100 - width)}%;width:${width}%;background:${run.failed ? 'var(--red)' : color}`,
        title: run.prompt,
        onclick: () => { f.sel = f.sel === key ? null : key; drawFleetTimeline(); },
        onmouseenter: (e) => fleetTip(e, lane, run, color),
        onmousemove: (e) => fleetTip(e, lane, run, color),
        onmouseleave: fleetTipHide,
      });
    });
    const liveRun = getAgent(lane.id)?.status?.run;
    return el('div', { class: 'fleet-lane' },
      el('div', { class: 'fleet-lane-label', title: `${lane.name}${lane.project ? ' · ' + lane.project : ''}` },
        el('span', { class: 'fleet-swatch' + (isRunning ? ' running' : ''), style: `background:${color}` }),
        el('a', { class: 'fleet-lane-name' + (lane.state === 'offline' ? ' offline' : ''), href: `#/agent/${encodeURIComponent(lane.id)}` }, lane.name),
        lane.project ? el('span', { class: 'fleet-lane-proj' }, lane.project) : null,
        lane.queue ? el('span', { class: 'fleet-lane-queue' }, `⧗ ${lane.queue}`) : null,
        isRunning && liveRun ? runClock(liveRun, 'sm') : null,
      ),
      el('div', { class: 'fleet-track' },
        bars.length ? bars : el('span', { class: 'fleet-track-empty' }, 'no runs in this window'),
      ),
    );
  });

  wrap.replaceChildren(
    lanes.length ? el('div', { class: 'fleet-tl' },
      el('div', { class: 'fleet-axis-row' },
        el('div', { class: 'fleet-gutter' }),
        el('div', { class: 'fleet-axis' },
          ticks.map((t) => el('span', { class: 'fleet-tick', style: `left:${pct(t)}%` }, fleetTickLabel(t, step)))),
      ),
      el('div', { class: 'fleet-lanes' }, gridlines, lanes),
    ) : el('div', { class: 'fleet-empty' }, 'No agents yet — launch one above.'),
  );
  updateFleetStats();
  drawFleetDetail();
}

// Run details under the timeline for the selected bar (also the accessible,
// non-hover record of every field the tooltip shows).
function drawFleetDetail() {
  const detail = $('#fleet-detail');
  if (!detail) return;
  const f = fleetState();
  if (!f.sel) {
    detail.replaceChildren(el('span', { class: 'fleet-note' }, 'Click a bar for run details.'));
    return;
  }
  const [agentId, startStr] = [f.sel.slice(0, f.sel.lastIndexOf(':')), +f.sel.slice(f.sel.lastIndexOf(':') + 1)];
  const lane = f.data?.lanes.find((l) => l.id === agentId);
  const run = lane?.runs.find((r) => r.start === startStr);
  if (!lane || !run) {
    f.sel = null;
    detail.replaceChildren(el('span', { class: 'fleet-note' }, 'Click a bar for run details.'));
    return;
  }
  const stateLabel = run.running ? `running · ${fmtClock(Date.now() - run.start)} elapsed` : run.failed ? 'failed' : 'complete';
  detail.replaceChildren(
    el('a', { class: 'fleet-lane-name', href: `#/agent/${encodeURIComponent(lane.id)}` }, lane.name),
    el('span', {}, run.pid ? projName(run.pid) : 'default workspace'),
    el('span', {}, stateLabel),
    el('span', {}, `took ${fmtClock(run.durationMs || 0)}`),
    run.running && run.estimateMs ? el('span', {}, `~${fmtClock(run.estimateMs)} est. (${run.estimateBasis})`) : null,
    typeof run.cost === 'number' ? el('span', {}, fmtCost(run.cost, run.estimated)) : null,
    el('span', {}, new Date(run.start).toLocaleString()),
    originChip(run.origin) || el('span', { class: 'fleet-note' }, 'no origin'),
    el('div', { class: 'fleet-detail-prompt' }, run.prompt || '(no prompt text)'),
  );
}

// Floating tooltip for a run bar. One shared node; positioned by cursor.
let fleetTipNode = null;

function fleetTip(e, lane, run, color) {
  if (!fleetTipNode) {
    fleetTipNode = el('div', { class: 'fleet-tip' });
    document.body.append(fleetTipNode);
  }
  const stateLabel = run.running ? 'running' : run.failed ? 'failed' : 'complete';
  fleetTipNode.replaceChildren(
    el('div', { class: 'fleet-tip-head' },
      el('span', { class: 'fleet-swatch', style: `background:${color}` }),
      el('strong', {}, lane.name),
      el('span', { class: run.failed ? 'fleet-tip-state failed' : 'fleet-tip-state' }, stateLabel),
    ),
    el('div', { class: 'fleet-tip-line' }, run.pid ? projName(run.pid) : 'default workspace'),
    el('div', { class: 'fleet-tip-line' }, `${fmtClock(run.durationMs || 0)} · ${new Date(run.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
    run.prompt ? el('div', { class: 'fleet-tip-prompt' }, run.prompt) : null,
  );
  fleetTipNode.style.display = 'block';
  const x = Math.min(e.clientX + 14, window.innerWidth - 360);
  fleetTipNode.style.left = x + 'px';
  fleetTipNode.style.top = Math.max(8, e.clientY - 12) + 'px';
}

function fleetTipHide() {
  if (fleetTipNode) fleetTipNode.style.display = 'none';
}

// Keep running bars growing and idle pages honest even without WS traffic.
setInterval(() => {
  if ($('#fleet-tl') && state.fleet?.data?.lanes?.some((l) => l.runs.some((r) => r.running))) {
    refreshFleetTimeline();
  }
}, 5000);

/* ── Run origin + duration estimate ──────────────────────────────── */

// Human label for where a run came from: chat, a board card, or the queue
// (which remembers what fed it).
function originLabel(origin) {
  if (!origin || !origin.kind) return null;
  const card = origin.taskTitle ? ' · ' + origin.taskTitle : '';
  if (origin.kind === 'chat') return '💬 chat';
  if (origin.kind === 'board') return '⌗ board' + card;
  if (origin.kind === 'fleet') return '⁂ fleet';
  if (origin.kind === 'queue') {
    const via = origin.via === 'board' ? '⌗ board' + card : origin.via === 'fleet' ? '⁂ fleet' : '💬 chat';
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

function agentCard(agent) {
  const st = agent.status || {};
  const stateName = st.state || 'offline';
  return el('a', {
    class: 'agent-card',
    href: `#/agent/${encodeURIComponent(agent.id)}`,
    style: `--card-accent:${agent.accent || 'var(--accent)'}`,
  },
    el('div', { class: 'agent-card-head' },
      el('span', { class: `dot ${stateName}` }),
      el('span', { class: 'agent-card-name' }, agent.name),
      el('span', { class: `state-badge ${stateName}` }, stateName),
    ),
    el('div', { class: 'agent-card-desc' }, agent.description || ''),
    el('div', { class: 'agent-card-task' + (st.currentTask ? '' : ' idle') },
      st.currentTask ? '▸ ' + st.currentTask : 'standing by',
    ),
    st.run ? el('div', { class: 'agent-card-run' },
      originChip(st.run.origin),
      runClock(st.run),
    ) : null,
    el('div', { class: 'agent-card-meta' },
      el('span', {}, '▣ ' + (st.project?.name || 'default ws')),
      el('span', {}, modelLabel(st)),
      st.queue?.length ? el('span', { class: 'card-queue' }, `⧗ ${st.queue.length} queued`) : null,
      st.subagents?.length ? el('span', { class: 'card-queue' }, `⑂ ${st.subagents.length} subagent${st.subagents.length === 1 ? '' : 's'}`) : null,
      el('span', {}, `runs ${st.totals?.runs ?? 0}`),
      el('span', {}, fmtCost(st.totals?.cost, st.totals?.estimated)),
      el('span', {}, `active ${fmtAgo(st.lastActivity)}`),
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
  const agentNames = (p.agents || []).map((aid) => getAgent(aid)?.name || aid);
  return el('div', { class: 'panel proj-card' },
    el('div', { class: 'proj-head' },
      el('strong', {}, p.name),
      el('span', { class: 'proj-path' }, p.path),
    ),
    p.description ? el('div', { class: 'proj-desc' }, p.description) : null,
    el('div', { class: 'proj-agents' },
      agentNames.length ? '⚡ ' + agentNames.join(', ') + ' pointed here' : 'no agents pointed here'),
    el('div', { class: 'proj-agents chist-line', id: 'chist-' + p.id }, '🧠 checking local Claude Code history…'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn sm', onclick: () => { location.hash = '#/project/' + encodeURIComponent(p.id); } }, '🧠 History'),
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
    return el('div', { class: 'feed-item', onclick: () => { location.hash = '#/agent/' + encodeURIComponent(item.agentId); } },
      el('span', { class: 'feed-time' }, fmtFeedTime(item.ts)),
      el('span', { class: 'feed-ic', style: `color:${color}` }, icon),
      el('span', { class: 'feed-text' },
        el('b', {}, item.agent), ' ', text,
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
        statTile(t.runs, 'Runs'),
        statTile(t.successRate === null ? '—' : Math.round(t.successRate * 100) + '%', 'Success rate',
          t.successRate !== null && t.successRate < 0.9 ? 'var(--amber)' : null),
        statTile(fmtDur(t.avgMs), 'Avg run'),
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
          el('div', { class: 'check-grid' }, evDone.row, evFail.row, evOff.row),
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

function dispatchMenu(task, x, y) {
  if (!state.agents.length) return toast('No agents available', true);
  showMenu(x, y, state.agents.map((a) => ({
    label: `▶ ${a.name}${a.status?.state === 'offline' ? ' (offline)' : a.status?.state === 'working' ? ' (will queue)' : ''}`,
    disabled: a.status?.state === 'offline',
    onclick: async () => {
      try {
        const r = await api(`/api/tasks/${task.id}/dispatch`, { method: 'POST', body: { agentId: a.id } });
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

  // Agent chips double as drag-to-dispatch drop targets.
  const agentChips = state.agents.map((a) => {
    const chip = el('div', { class: `kb-agent ${a.status?.state || 'offline'}` },
      el('span', { class: `dot ${a.status?.state || 'offline'}` }),
      el('span', {}, a.name),
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
        const r = await api(`/api/tasks/${taskId}/dispatch`, { method: 'POST', body: { agentId: a.id } });
        toast(r.queued ? `Dispatched to ${a.name} — queued #${r.position}` : `Dispatched to ${a.name}`);
      } catch (err) { toast(err.message, true); }
    });
    return chip;
  });

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
  const agent = task.agentId ? getAgent(task.agentId) : null;
  const card = el('div', { class: 'kb-card', draggable: 'true' },
    el('div', { class: 'kb-card-title' }, task.title),
    task.description ? el('div', { class: 'kb-card-desc' }, task.description) : null,
    el('div', { class: 'kb-card-foot' },
      agent ? el('span', { class: 'kb-card-agent' },
        el('span', { class: `dot ${agent.status?.state || 'offline'}` }), agent.name) : null,
      task.result === 'error' ? el('span', { class: 'kb-badge err' }, 'failed') : null,
      task.result === 'stopped' ? el('span', { class: 'kb-badge warn' }, 'stopped') : null,
      el('span', { class: 'kb-spacer' }),
      task.cid && task.agentId ? el('button', {
        class: 'btn sm', title: 'Open the session that worked this card',
        onclick: (e) => {
          e.stopPropagation();
          state.sessionSel[task.agentId] = task.cid;
          state.tab = 'sessions';
          location.hash = '#/agent/' + encodeURIComponent(task.agentId);
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

/* ── Project history (native Claude Code session store) ──────────── */

async function renderProjectHistory(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) {
    location.hash = '#/projects';
    return;
  }
  main.replaceChildren(el('div', { class: 'ws-empty', style: 'height:100%' }, 'Reading local Claude Code store…'));
  let data;
  try {
    data = await api(`/api/projects/${projectId}/claude-sessions`);
  } catch (err) {
    main.replaceChildren(el('div', { class: 'page' }, el('p', { class: 'page-sub' }, err.message)));
    return;
  }

  const list = el('div', { class: 'ws-list' });
  const detail = el('div', { class: 'sess-detail' });
  let selectedId = null;

  main.replaceChildren(
    el('div', { class: 'agent-page' },
      el('header', { class: 'agent-header' },
        el('a', { href: '#/projects', class: 'btn sm' }, '← Projects'),
        el('h1', {}, project.name + ' — history'),
        el('span', { class: 'header-task', title: data.storeDir },
          `local Claude Code sessions for ${project.path}`),
      ),
      el('div', { class: 'agent-body' },
        el('div', { class: 'ws-wrap' },
          el('div', { class: 'ws-tree', style: 'width:320px' },
            el('div', { class: 'ws-tree-head' },
              el('span', { class: 'crumb' }, `${data.sessions.length} session${data.sessions.length === 1 ? '' : 's'}`),
            ),
            list,
          ),
          detail,
        ),
      ),
    )
  );

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
    list.replaceChildren(...data.sessions.map(sessionEntry));
    if (!data.sessions.length) {
      list.append(el('div', { class: 'ws-empty', style: 'padding:20px' },
        'No sessions ran from this exact folder.'));
    }
    if (data.parentSessions?.length) {
      list.append(
        el('div', { class: 'git-section-title' }, 'FROM PARENT FOLDERS'),
        ...data.parentSessions.map(sessionEntry),
      );
    }
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
    const log = el('div', { class: 'chat-log' });
    const pseudo = {
      cid: s.id,
      pid: projectId,
      events: sess.events,
      startedAt: s.startTs || s.mtime,
      endedAt: s.mtime,
      runs: 0,
      cost: 0,
      prompts: sess.events.filter((e) => e.type === 'user_prompt').length,
      models: new Set(s.model ? [s.model] : []),
    };
    detail.replaceChildren(
      el('div', { class: 'sess-detail-head' },
        el('span', {}, 'session ' + s.id.slice(0, 8)),
        el('span', {}, `${pseudo.prompts} messages`),
        sess.truncated ? el('span', {}, `(showing last ${sess.events.length} of ${sess.total} events)`) : null,
        el('span', { class: 'kb-spacer' }),
        el('button', {
          class: 'btn sm',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(sessionToMarkdown({ name: project.name, id: 'claude-local' }, pseudo));
              toast('Transcript copied as Markdown');
            } catch (err) { toast(err.message, true); }
          },
        }, '⧉ Copy'),
        el('button', {
          class: 'btn sm',
          onclick: () => downloadSessionMd({ name: project.name, id: 'claude-local' }, pseudo),
        }, '⬇ Export'),
      ),
      log,
    );
    for (const ev of sess.events) {
      const node = renderEvent(ev);
      if (node) log.append(node);
    }
    log.scrollTop = log.scrollHeight;
  }

  renderList();
  const first = data.sessions[0] || data.parentSessions?.[0];
  if (first) openSession(first);
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

/* ── Agent page ──────────────────────────────────────────────────── */

function renderAgentPage(agent) {
  const tabs = [
    ['chat', 'Chat'],
    ['sessions', 'Sessions'],
    ['git', 'Git'],
    ['workspace', 'Workspace'],
    ['control', 'Control Room'],
  ];
  const st = agent.status || {};
  main.replaceChildren(
    el('div', { class: 'agent-page' },
      el('header', { class: 'agent-header' },
        el('span', { class: `dot ${st.state || 'offline'}`, id: 'hdr-dot' }),
        el('h1', {}, agent.name),
        el('span', { class: 'header-task', id: 'hdr-task' }, ...headerTaskNodes(st)),
        el('select', { class: 'hdr-model', id: 'hdr-project', title: 'Project' },
          el('option', {}, '▣ ' + (st.project?.name || 'default workspace'))),
        el('select', { class: 'hdr-model', id: 'hdr-model', title: 'Model' },
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
  populateProjectSelect(agent);
  state.agentProj[agent.id] = st.project?.id || null;
  state.agentCid[agent.id] = st.cid || null;
}

// Header project dropdown — pointing the agent at a project (or the default
// workspace). Switching saves the current session and resumes the one last
// used for that project.
function populateProjectSelect(agent) {
  const sel = $('#hdr-project');
  if (!sel || document.activeElement === sel) return;
  const cur = agent.status?.project?.id || '';
  sel.replaceChildren(
    el('option', { value: '' }, '▣ default workspace'),
    ...state.projects.map((p) =>
      el('option', { value: p.id, selected: cur === p.id ? '' : null }, '▣ ' + p.name)),
  );
  sel.value = cur;
  sel.onchange = async () => {
    try {
      await api(`/api/agents/${agent.id}/project`, {
        method: 'POST',
        body: { projectId: sel.value || null },
      });
    } catch (err) {
      toast(err.message, true);
      populateProjectSelect(agent);
    }
  };
}

// Fill the header model dropdown from the agent's settings schema; changing it
// persists the setting (takes effect on the next run).
async function populateModelSelect(agent) {
  const sel = $('#hdr-model');
  if (!sel || document.activeElement === sel) return;
  let settings;
  try {
    settings = await api(`/api/agents/${agent.id}/settings`);
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
      await api(`/api/agents/${agent.id}/settings`, { method: 'PUT', body: { model: sel.value } });
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
  const agent = getAgent(agentId);
  if (!agent) return;
  const st = agent.status || {};
  const projChanged = (st.project?.id || null) !== (state.agentProj[agentId] ?? (st.project?.id || null));
  const cidChanged = (st.cid || null) !== (state.agentCid[agentId] ?? (st.cid || null));
  state.agentProj[agentId] = st.project?.id || null;
  state.agentCid[agentId] = st.cid || null;
  if (projChanged) {
    state.wsFile[agentId] = { dir: '', selected: null };
    state.fileTree[agentId] = null;
  }

  if (currentAgentId() === agentId) {
    const dot = $('#hdr-dot');
    if (dot) dot.className = `dot ${st.state || 'offline'}`;
    const task = $('#hdr-task');
    if (task) task.replaceChildren(...headerTaskNodes(st));
    const body = $('#agent-body');
    if (state.tab === 'chat') {
      if ((projChanged || cidChanged) && body) renderChat(agent, body);
      else {
        updateWorkingBar(agent);
        updateQueueBar(agent);
      }
    }
    if (state.tab === 'workspace' && projChanged && body) renderWorkspace(agent, body);
    if (state.tab === 'git' && projChanged && body) renderGit(agent, body);
    if (state.tab === 'control') refreshControlInfo(agent);
    populateModelSelect(agent);
    populateProjectSelect(agent);
  } else if (onBoardPage()) {
    renderBoard();
  } else if (onFleetPage()) {
    // New agent (spawned by a fleet launch) or state change — refetch lanes.
    scheduleFleetRefresh();
  } else if (!currentAgentId() && !onOtherPage()) {
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
  if (input && currentAgentId() === agentId) {
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
  const v = state.voice && state.voice.agentId === currentAgentId() ? state.voice : null;
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
    base: input && currentAgentId() === agent.id ? input.value : (state.drafts[agent.id] || ''),
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
  const inView = live && currentAgentId() === v.agentId;
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
        if (v.agentId !== agent.id) return toast(`Already ${v.backend === 'whisper' ? 'recording' : 'dictating'} for another agent`, true);
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
    try { items = await api(`/api/agents/${agent.id}/skills`); } catch {}
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
      const saved = await api(`/api/agents/${agent.id}/attach`, {
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
        await api(`/api/agents/${agent.id}/session/clear`, { method: 'POST' });
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
      const result = await api(`/api/agents/${agent.id}/chat`, { method: 'POST', body: { message: text } });
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
      `fresh session in ${agent.status?.project?.name || 'default workspace'} — send a message to begin`));
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
          onclick: () => api(`/api/agents/${agent.id}/stop`, { method: 'POST' }).catch((e) => toast(e.message, true)),
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
                await api(`/api/agents/${agent.id}/queue/${task.id}`, { method: 'DELETE' });
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
    await api(`/api/agents/${agent.id}/queue/reorder`, {
      method: 'POST',
      body: { order: queue.map((t) => t.id) },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

function onAgentEvent(agentId, event) {
  if (currentAgentId() !== agentId) return;
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
      const agent = getAgent(agentId);
      if (agent) renderSessions(agent, body);
    } else if (log && state.sessionSel[agentId] === event.cid) {
      const node = renderEvent(event);
      if (node) log.append(node);
      log.scrollTop = log.scrollHeight;
    }
  } else if (state.tab === 'git') {
    // A finished run likely changed files — refresh the review pane.
    if (event.type === 'result') {
      const agent = getAgent(agentId);
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
    st = await api(`/api/agents/${agent.id}/git/status`);
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
              await api(`/api/agents/${agent.id}/git/init`, { method: 'POST', body: {} });
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
      api(`/api/agents/${agent.id}/git/log?limit=15`),
      api(`/api/agents/${agent.id}/git/branches`),
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
      const data = await api(`/api/agents/${agent.id}/git/diff${q}`);
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
      const data = await api(`/api/agents/${agent.id}/git/show?hash=` + hash);
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
      await api(`/api/agents/${agent.id}/git/checkout`, { method: 'POST', body: { name: branchSel.value } });
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
        const r = await api(`/api/agents/${agent.id}/git/commit`, { method: 'POST', body: { message: commitMsg.value } });
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
                await api(`/api/agents/${agent.id}/git/branch`, { method: 'POST', body: { name } });
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
              await api(`/api/agents/${agent.id}/git/discard`, { method: 'POST', body: { path: change.path } });
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
      data = await api(`/api/agents/${agent.id}/files?path=${encodeURIComponent(rel)}`);
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
                await api(`/api/agents/${agent.id}/file`, { method: 'PUT', body: { path: name, content: '' } });
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
      data = await api(`/api/agents/${agent.id}/file?path=${encodeURIComponent(relPath)}`);
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
          await api(`/api/agents/${agent.id}/file`, {
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
    settings = await api(`/api/agents/${agent.id}/settings`);
  } catch {
    settings = { schema: [], values: {} };
  }

  const fields = settings.schema.map((field) => {
    const saveValue = async (value) => {
      try {
        await api(`/api/agents/${agent.id}/settings`, { method: 'PUT', body: { [field.key]: value } });
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
          fields.length ? fields : el('div', { class: 'ws-empty' }, 'No settings for this agent'),
        ),
        el('div', { class: 'panel' },
          el('h3', {}, 'Session'),
          el('div', { id: 'ctl-info' }),
          el('div', { class: 'btn-row', style: 'margin-top:14px' },
            el('button', {
              class: 'btn danger',
              onclick: () => api(`/api/agents/${agent.id}/stop`, { method: 'POST' })
                .then(() => toast('Abort signal sent'))
                .catch((e) => toast(e.message, true)),
            }, 'Abort current run'),
            el('button', {
              class: 'btn',
              onclick: () => api(`/api/agents/${agent.id}/session/clear`, { method: 'POST' })
                .then(() => toast('Session cleared'))
                .catch((e) => toast(e.message, true)),
            }, 'New session'),
            el('button', {
              class: 'btn',
              onclick: () => {
                if (!confirm('Clear all chat history for this agent?')) return;
                api(`/api/agents/${agent.id}/history/clear`, { method: 'POST' })
                  .then(() => toast('History cleared'))
                  .catch((e) => toast(e.message, true));
              },
            }, 'Clear history'),
            agent.dynamic ? el('button', {
              class: 'btn danger',
              onclick: async () => {
                if (!confirm(`Retire agent "${agent.name}"?\nIts chat history is deleted; workspace files stay on disk.`)) return;
                try {
                  await api('/api/agents/' + agent.id, { method: 'DELETE' });
                  toast('Agent retired');
                  location.hash = '#/';
                } catch (err) { toast(err.message, true); }
              },
            }, 'Retire agent') : null,
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
    [state.agents, state.projects] = await Promise.all([
      api('/api/agents'),
      api('/api/projects'),
    ]);
  } catch (err) {
    toast('Failed to reach server: ' + err.message, true);
  }
  renderSidebar();
  route();
  connectWS();
})();
