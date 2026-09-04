const fs = require('fs');
const os = require('os');
const path = require('path');
const adapters = require('./adapters');
const gitLib = require('./git');
const mcNotes = require('./mc-notes');
const Vault = require('./vault');

// Retained events per project. Several instances can write to one project's
// history at once, so the cap is per project rather than per agent.
const HISTORY_CAP = 2000;
const ACCENTS = ['#d97757', '#5eb0ff', '#34d399', '#fbbf24', '#c084fc', '#f472b6'];
const DATA_MODEL = 2;

function isoDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function slugify(s, fallback) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function failedResult(ev) {
  return !!(ev.is_error || (ev.subtype && ev.subtype !== 'success'));
}

// Pricing as stored on a registered agent (M15 folded into M21):
//   plan, amount + currency per period, renewsOn   flat subscription
//   perMillion                                     rate card, or model → card
// `monthly` from older configs becomes amount / USD / month. Rates that
// aren't non-negative numbers are dropped, and an empty result is null so the
// caller deletes the key.
const RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const SECRET_KEY = /token|secret|key|password|passwd|credential/i;

function isRateCard(p) {
  return !!p && typeof p === 'object' && RATE_KEYS.some((k) => k in p);
}

function cleanRateCard(card) {
  if (!card || typeof card !== 'object') return null;
  const out = {};
  for (const k of RATE_KEYS) {
    if (card[k] === '' || card[k] === null || card[k] === undefined) continue;
    const n = Number(card[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

function normalizePricing(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  const plan = String(p.plan || '').trim();
  const rawAmount = p.amount !== undefined ? p.amount : p.monthly;
  const amount = rawAmount === '' || rawAmount === null || rawAmount === undefined ? NaN : Number(rawAmount);
  if (plan || Number.isFinite(amount)) {
    out.plan = plan || 'Subscription';
    if (Number.isFinite(amount) && amount >= 0) {
      out.amount = amount;
      out.currency = String(p.currency || 'USD').trim().toUpperCase().slice(0, 3) || 'USD';
      out.period = p.period === 'year' ? 'year' : 'month';
    }
    const renews = String(p.renewsOn || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(renews) && !Number.isNaN(Date.parse(renews))) out.renewsOn = renews;
  }
  if (p.perMillion && typeof p.perMillion === 'object') {
    if (isRateCard(p.perMillion)) {
      const card = cleanRateCard(p.perMillion);
      if (card) out.perMillion = card;
    } else {
      const map = {};
      for (const [model, card] of Object.entries(p.perMillion)) {
        const key = String(model).trim();
        const c = cleanRateCard(card);
        if (key && c) map[key] = c;
      }
      const keys = Object.keys(map);
      if (keys.length === 1 && map.default) out.perMillion = map.default;
      else if (keys.length) out.perMillion = map;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Next renewal after `iso` (YYYY-MM-DD), one period on, day clamped to the
// month's length so the 31st doesn't drift into the following month.
function addPeriod(iso, period) {
  const [y, m, d] = iso.split('-').map(Number);
  let yy = y, mm = m;
  if (period === 'year') yy += 1;
  else if (++mm > 12) { mm = 1; yy += 1; }
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function daysUntil(iso, now) {
  return Math.round((Date.parse(iso) - Date.parse(isoDay(now))) / 864e5);
}

// Two kinds of thing live here (Round 5):
//
//   Registered agents — definitions: name, type, description, models,
//     pricing, env. Seeded once from agents.config.js into data/agents.json,
//     owned by the dashboard from then on. They never chat.
//   Instances — a live adapter of one registered agent working against one
//     project. Any number per agent, each with its own queue, run record and
//     conversation. Closed by hand when idle; persisted so a restart brings
//     them back idle.
//
// History belongs to the project: data/history-<projectId>.json, every event
// stamped with the agent and instance that produced it.
class AgentManager {
  constructor(config, broadcast, rootDir) {
    this.broadcast = broadcast;
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.settingsAll = readJson(this.settingsFile, {});
    this.projectsFile = path.join(this.dataDir, 'projects.json');
    this.projects = readJson(this.projectsFile, []);
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.stateAll = readJson(this.stateFile, {});
    this.registryFile = path.join(this.dataDir, 'agents.json');
    this.instancesFile = path.join(this.dataDir, 'instances.json');
    this.tasksFile = path.join(this.dataDir, 'tasks.json');
    this.tasks = readJson(this.tasksFile, []);
    this.promptsFile = path.join(this.dataDir, 'prompts.json');
    this.prompts = readJson(this.promptsFile, []);
    this.saveTimers = new Map();
    this.histories = new Map();   // projectId -> events[]
    this.instances = new Map();   // instance id -> entry
    this.probes = new Map();      // agentId -> adapter used for availability + schema
    this.vault = new Vault(Vault.resolveDir(this.settingsAll, rootDir));

    if (this.stateAll._model !== DATA_MODEL) this.migrateV1(config);
    this.registry = readJson(this.registryFile, []);
    this.seedRegistry(config);
    for (const cfg of this.registry) {
      const pricing = normalizePricing(cfg.pricing);
      if (pricing) cfg.pricing = pricing; else delete cfg.pricing;
    }
    for (const cfg of this.registry) this.ensureProbe(cfg);
    for (const p of this.projects) this.historyFor(p.id);
    for (const rec of readJson(this.instancesFile, [])) {
      if (!this.findAgent(rec.agentId) || !this.findProject(rec.projectId)) continue;
      this.createInstanceEntry(rec);
    }
  }

  /* ── Registry ──────────────────────────────────────────────────── */

  // agents.config.js is the seed for fresh installs: each entry is copied into
  // the registry once, remembered in state so a removed built-in stays gone.
  seedRegistry(config) {
    const seeded = new Set(this.stateAll._seeded || []);
    let changed = false;
    for (const cfg of config.agents || []) {
      if (seeded.has(cfg.id)) continue;
      seeded.add(cfg.id);
      if (!this.registry.some((a) => a.id === cfg.id)) {
        const { workspace, ...rest } = cfg;   // instances work in project roots, never a private workspace
        this.registry.push({ ...rest, createdAt: Date.now() });
      }
      changed = true;
    }
    if (changed) {
      this.stateAll._seeded = [...seeded];
      this.saveState();
      this.saveRegistry();
    }
  }

  ensureProbe(cfg) {
    const Adapter = adapters[cfg.type];
    if (!Adapter) {
      console.warn(`No adapter registered for type "${cfg.type}" (agent ${cfg.id})`);
      return null;
    }
    let probe = this.probes.get(cfg.id);
    if (probe && probe.constructor === Adapter) {
      probe.config = cfg;
      return probe;
    }
    probe = new Adapter(cfg, {
      workspaceDir: this.rootDir,
      getWorkspaceDir: () => this.rootDir,
      getSettings: () => this.settingsAll[cfg.id] || {},
    });
    let lastState = null;
    probe.on('status', (status) => {
      this.propagateAvailability(cfg.id);
      // The CLI going away is one alert per agent, not one per instance.
      if (this.notifier && lastState && lastState !== 'offline' && status.state === 'offline') {
        this.notifier.agentOffline(cfg.name);
      }
      lastState = status.state;
    });
    this.probes.set(cfg.id, probe);
    return probe;
  }

  findAgent(id) {
    return this.registry.find((a) => a.id === id);
  }

  getAgent(id) {
    const cfg = this.findAgent(id);
    if (!cfg) throw httpError(404, 'Unknown agent');
    return cfg;
  }

  agentTypes() {
    return Object.entries(adapters).map(([type, Adapter]) => ({
      type,
      label: Adapter.displayName || type,
    }));
  }

  // Config as exposed to the browser. Env values are shown so the M21 form
  // can edit them, except that a plain value under a secret-looking key
  // (token, key, password…) is sent as `{ secret: true }` — the form keeps
  // the stored value unless a new one is typed. File-backed entries only
  // ever hold the path, which is fine to show.
  publicAgent(cfg) {
    const { env, ...rest } = cfg;
    const probe = this.probes.get(cfg.id);
    const shown = {};
    for (const [k, v] of Object.entries(env || {})) {
      if (v && typeof v === 'object' && v.file) shown[k] = { file: String(v.file) };
      else if (SECRET_KEY.test(k)) shown[k] = { secret: true };
      else shown[k] = String(v);
    }
    return {
      ...rest,
      env: Object.keys(shown).length ? shown : undefined,
      customEnv: env && Object.keys(env).length ? Object.keys(env) : undefined,
      available: probe ? probe.state !== 'offline' : false,
      instances: this.instancesOf(cfg.id).map((e) => e.id),
    };
  }

  listAgents() {
    return this.registry.map((cfg) => this.publicAgent(cfg));
  }

  instancesOf(agentId) {
    return [...this.instances.values()].filter((e) => e.agentId === agentId);
  }

  addAgent(body) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'Agent name is required');
    const type = String(body.type || 'claude-code');
    if (!adapters[type]) throw httpError(400, `Unknown agent type "${type}"`);
    let id = slugify(name, 'agent');
    const base = id;
    let n = 2;
    while (this.findAgent(id)) id = `${base}-${n++}`;
    const cfg = {
      id,
      name,
      type,
      description: String(body.description || '') || `${adapters[type].displayName || type} agent`,
      accent: String(body.accent || '') || ACCENTS[this.registry.length % ACCENTS.length],
      createdAt: Date.now(),
    };
    this.applyAgentPatch(cfg, body);
    this.registry.push(cfg);
    this.saveRegistry();
    const probe = this.ensureProbe(cfg);
    if (probe) probe.refreshAvailability();
    this.broadcastAgents();
    return this.publicAgent(cfg);
  }

  // Optional definition fields shared by register and edit. Env values are a
  // string or `{ file }`; the token itself never lands in the data dir.
  applyAgentPatch(cfg, patch) {
    if (patch.models !== undefined) {
      const models = Array.isArray(patch.models) ? patch.models
        .map((m) => (m && typeof m === 'object' ? { value: String(m.value || '').trim(), label: String(m.label || m.value || '').trim() } : null))
        .filter((m) => m && m.value) : [];
      if (models.length) cfg.models = models; else delete cfg.models;
    }
    if (patch.pricing !== undefined) {
      const pricing = normalizePricing(patch.pricing);
      if (pricing) cfg.pricing = pricing; else delete cfg.pricing;
    }
    if (patch.env !== undefined) {
      const env = {};
      for (const [k, v] of Object.entries(patch.env || {})) {
        const key = String(k).trim();
        if (!key) continue;
        if (v && typeof v === 'object' && v.secret) {
          // Masked in the browser; keep whatever is stored under that key.
          if (cfg.env && cfg.env[key] !== undefined) env[key] = cfg.env[key];
        } else if (v && typeof v === 'object' && v.file) {
          if (String(v.file).trim()) env[key] = { file: String(v.file).trim() };
        } else if (v !== null && v !== undefined && String(v) !== '') env[key] = String(v);
      }
      if (Object.keys(env).length) cfg.env = env; else delete cfg.env;
    }
  }

  updateAgent(id, patch) {
    const cfg = this.getAgent(id);
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw httpError(400, 'Agent name is required');
      cfg.name = name;
    }
    if (patch.type !== undefined && patch.type !== cfg.type) {
      if (!adapters[patch.type]) throw httpError(400, `Unknown agent type "${patch.type}"`);
      if (this.instancesOf(id).length) throw httpError(409, 'Close this agent\'s instances before changing its type');
      cfg.type = String(patch.type);
    }
    if (patch.description !== undefined) cfg.description = String(patch.description);
    if (patch.accent !== undefined && String(patch.accent).trim()) cfg.accent = String(patch.accent).trim();
    this.applyAgentPatch(cfg, patch);
    this.saveRegistry();
    const probe = this.ensureProbe(cfg);
    if (probe) probe.refreshAvailability();
    // Stored results were priced with whatever config was live at the time;
    // a pricing change re-derives them.
    if (probe && typeof probe.reprice === 'function') {
      for (const [pid, events] of this.histories) {
        let touched = false;
        for (const ev of events) {
          if (ev.agentId === id && ev.type === 'result') { probe.reprice(ev); touched = true; }
        }
        if (touched) this.scheduleSave(pid);
      }
    }
    for (const e of this.instancesOf(id)) this.broadcastStatus(e.id);
    this.broadcastAgents();
    return this.publicAgent(cfg);
  }

  removeAgent(id) {
    this.getAgent(id);
    const live = this.instancesOf(id);
    if (live.length) {
      throw httpError(409, `Close ${live.length === 1 ? 'its instance' : `its ${live.length} instances`} before removing this agent`);
    }
    this.registry = this.registry.filter((a) => a.id !== id);
    this.saveRegistry();
    const probe = this.probes.get(id);
    if (probe) probe.removeAllListeners();
    this.probes.delete(id);
    delete this.settingsAll[id];
    this.saveSettings();
    this.broadcastAgents();
  }

  saveRegistry() {
    fs.writeFileSync(this.registryFile, JSON.stringify(this.registry, null, 2));
  }

  /* ── Subscriptions (M15, folded into M21) ──────────────────────── */

  // One row per registered agent on a flat-rate plan. `daysToRenewal` is
  // whole days from today (negative = overdue, null = no date set);
  // `monthlyEquivalent` puts yearly plans on the same footing for totals.
  subscriptions(now = Date.now()) {
    return this.registry.filter((a) => a.pricing?.plan).map((a) => {
      const p = a.pricing;
      const hasAmount = typeof p.amount === 'number';
      return {
        agentId: a.id,
        name: a.name,
        plan: p.plan,
        amount: hasAmount ? p.amount : null,
        currency: p.currency || 'USD',
        period: p.period || 'month',
        renewsOn: p.renewsOn || null,
        daysToRenewal: p.renewsOn ? daysUntil(p.renewsOn, now) : null,
        monthlyEquivalent: hasAmount ? (p.period === 'year' ? p.amount / 12 : p.amount) : null,
      };
    });
  }

  // Polled every few minutes from server.js. Reminds the day before each
  // renewal (or on the day, if the server was down for the eve), once per
  // renewal date; once the date has passed it rolls forward one period so
  // the reminder recurs without the user re-entering it.
  checkRenewals(now = Date.now()) {
    let changed = false;
    for (const a of this.registry) {
      const p = a.pricing;
      if (!p?.renewsOn) continue;
      let days = daysUntil(p.renewsOn, now);
      if (days < 0) {
        while (days < 0) { p.renewsOn = addPeriod(p.renewsOn, p.period); days = daysUntil(p.renewsOn, now); }
        changed = true;
      }
      if (days <= 1 && this.notifier) {
        this.notifier.renewalDue({
          agentId: a.id, agent: a.name, plan: p.plan, amount: p.amount, currency: p.currency,
          period: p.period, renewsOn: p.renewsOn, daysToRenewal: days,
        });
      }
    }
    if (changed) {
      this.saveRegistry();
      this.broadcastAgents();
    }
  }

  broadcastAgents() {
    this.broadcast({ type: 'agents', agents: this.listAgents() });
  }

  /* ── Instances ─────────────────────────────────────────────────── */

  // Build the live entry for a persisted instance record: adapter, restored
  // conversation pointer, queue. Availability is copied from the agent's
  // probe so a fresh instance doesn't sit "offline" until the next poll.
  createInstanceEntry(rec) {
    const cfg = this.getAgent(rec.agentId);
    const Adapter = adapters[cfg.type];
    if (!Adapter) throw httpError(500, `No adapter for type "${cfg.type}"`);
    const entry = {
      id: rec.id,
      agentId: cfg.id,
      name: rec.name,
      projectId: rec.projectId,
      createdAt: rec.createdAt || Date.now(),
      conversationId: rec.cid || null,
      reportedSkills: Array.isArray(rec.skills) ? rec.skills : null,
      settings: rec.settings && typeof rec.settings === 'object' ? rec.settings : {},
      queue: Array.isArray(rec.queue) ? rec.queue : [],
      run: null,
      currentTaskId: null,
    };
    const ctx = {
      workspaceDir: this.getWorkspaceDir(entry),
      getWorkspaceDir: () => this.getWorkspaceDir(entry),
      getSettings: () => ({ ...(this.settingsAll[cfg.id] || {}), ...entry.settings }),
      getVaultSpawn: () => this.vaultSpawnFor(entry.id),
    };
    const adapter = new Adapter(this.findAgent(cfg.id), ctx);
    entry.adapter = adapter;
    adapter.sessionId = rec.sessionId || null;
    const history = this.historyFor(entry.projectId);
    for (let i = history.length - 1; i >= 0; i--) {
      const ev = history[i];
      if (ev.iid === entry.id && ev.type === 'system' && ev.subtype === 'init' && ev.model) { adapter.model = ev.model; break; }
    }
    if (!entry.reportedSkills && typeof adapter.skillsFromInit === 'function') {
      for (let i = history.length - 1; i >= 0 && !entry.reportedSkills; i--) {
        if (history[i].iid === entry.id) entry.reportedSkills = adapter.skillsFromInit(history[i]);
      }
    }
    const probe = this.probes.get(cfg.id);
    if (probe && probe.state !== 'offline') adapter.state = probe.state;

    adapter.on('status', () => {
      // The run record lives exactly as long as the adapter is working.
      if (!adapter.isBusy()) entry.run = null;
      const status = this.statusOf(entry);
      this.broadcast({ type: 'instance_status', iid: entry.id, status });
      // An aborted run ends without a result event — park its card in Review.
      if (status.state === 'online' && entry.currentTaskId) {
        this.finalizeTask(entry, 'stopped');
      }
      // Drain the queue whenever the instance comes free.
      if (status.state === 'online' && entry.queue.length && !adapter.isBusy()) {
        setTimeout(() => this.dispatchNext(entry.id), 400);
      }
    });
    adapter.on('event', (event) => this.pushEvent(entry.id, event));
    adapter.on('partial', ({ text }) => {
      this.broadcast({ type: 'instance_partial', iid: entry.id, text });
    });
    this.instances.set(entry.id, entry);
    return entry;
  }

  // Launch: a new instance of a registered agent on a project, optionally
  // with an opening prompt already sent.
  launchInstance(agentId, { projectId, prompt } = {}) {
    const cfg = this.getAgent(agentId);
    const project = projectId ? this.findProject(projectId) : null;
    if (!projectId) throw httpError(400, 'An instance needs a project');
    if (!project) throw httpError(404, 'Unknown project');
    const base = `${project.name} · ${cfg.name}`;
    let name = base;
    let n = 2;
    while ([...this.instances.values()].some((e) => e.name === name)) name = `${base} ${n++}`;
    const rec = {
      id: newId('i'),
      agentId: cfg.id,
      projectId: project.id,
      name,
      createdAt: Date.now(),
      cid: 's-' + Date.now(),
      sessionId: null,
      skills: null,
      settings: {},
      queue: [],
    };
    const entry = this.createInstanceEntry(rec);
    this.saveInstances();
    this.broadcastInstances();
    this.refreshProjectCatalog(project);
    let send = { queued: false };
    const text = String(prompt || '').trim();
    if (text) send = this.sendChat(entry.id, text);
    return { ...this.publicInstance(entry), ...send };
  }

  closeInstance(iid) {
    const entry = this.get(iid);
    if (entry.adapter.isBusy()) throw httpError(409, 'Instance is working — abort its run or wait for it to finish');
    entry.adapter.stop();
    entry.adapter.removeAllListeners();
    this.instances.delete(iid);
    this.saveInstances();
    this.broadcastInstances();
    this.refreshCatalogFor(entry.projectId);
  }

  get(iid) {
    const entry = this.instances.get(iid);
    if (!entry) throw httpError(404, 'Unknown instance');
    return entry;
  }

  statusOf(entry) {
    const status = entry.adapter.getStatus();
    const project = this.findProject(entry.projectId);
    status.project = project ? { id: project.id, name: project.name, path: project.path } : null;
    status.cid = entry.conversationId;
    status.queue = entry.queue.map((t) => ({ id: t.id, text: t.text, queuedAt: t.queuedAt, origin: t.origin || null }));
    status.run = entry.run || null;
    return status;
  }

  publicInstance(entry) {
    const cfg = this.findAgent(entry.agentId) || {};
    return {
      id: entry.id,
      name: entry.name,
      agentId: entry.agentId,
      agent: cfg.name || entry.agentId,
      type: cfg.type,
      accent: cfg.accent,
      projectId: entry.projectId,
      createdAt: entry.createdAt,
      status: this.statusOf(entry),
    };
  }

  listInstances() {
    return [...this.instances.values()].map((e) => this.publicInstance(e));
  }

  broadcastStatus(iid) {
    const entry = this.instances.get(iid);
    if (!entry) return;
    this.broadcast({ type: 'instance_status', iid, status: this.statusOf(entry) });
  }

  broadcastInstances() {
    this.broadcast({ type: 'instances', instances: this.listInstances() });
  }

  instanceRecord(entry) {
    return {
      id: entry.id,
      agentId: entry.agentId,
      projectId: entry.projectId,
      name: entry.name,
      createdAt: entry.createdAt,
      cid: entry.conversationId,
      sessionId: entry.adapter.sessionId,
      skills: entry.reportedSkills || null,
      settings: entry.settings,
      queue: entry.queue,
    };
  }

  saveInstances() {
    clearTimeout(this.instancesTimer);
    this.instancesTimer = null;
    fs.writeFileSync(this.instancesFile, JSON.stringify([...this.instances.values()].map((e) => this.instanceRecord(e)), null, 2));
  }

  // Event-path variant: conversation pointers change on every stream event,
  // so coalesce those writes.
  scheduleInstancesSave() {
    if (this.instancesTimer) return;
    this.instancesTimer = setTimeout(() => { this.instancesTimer = null; this.saveInstances(); }, 500);
  }

  init() {
    this.pollAvailability();
    this.pollTimer = setInterval(() => this.pollAvailability(), 20000);
    this.ensureVault();
  }

  // One CLI probe per registered agent, not per instance; the result is
  // copied onto every idle instance of that agent.
  async pollAvailability() {
    const before = JSON.stringify([...this.probes].map(([id, p]) => [id, p.state]));
    for (const probe of this.probes.values()) {
      try {
        await probe.refreshAvailability();
      } catch {}
    }
    const after = JSON.stringify([...this.probes].map(([id, p]) => [id, p.state]));
    if (after !== before) this.broadcastAgents();
  }

  propagateAvailability(agentId) {
    const probe = this.probes.get(agentId);
    if (!probe) return;
    for (const entry of this.instancesOf(agentId)) {
      if (entry.adapter.isBusy() || entry.adapter.state === probe.state) continue;
      entry.adapter.setState(probe.state);
    }
  }

  /* ── Fleet vault ───────────────────────────────────────────────── */

  vaultEnabled() {
    return (this.settingsAll._vault || {}).enabled !== false;
  }

  // Initialize the vault on boot, then reconcile the catalog with live
  // project data (M13): refresh every registered project's page and retire
  // pages whose project went away. Finish by distilling the roadmap's
  // planning decisions into `_mc/` notes.
  async ensureVault() {
    if (!this.vaultEnabled()) return;
    try {
      await this.vault.ensure();
      for (const p of this.projects) {
        await this.vault.refreshCatalog(this.catalogInfoFor(p));
      }
      const live = new Set(this.projects.map((p) => p.id));
      for (const e of this.vault.index().filter((x) => x.path.startsWith('_catalog/'))) {
        const slug = e.path.split('/')[1].replace(/\.md$/, '');
        if (!live.has(slug)) await this.vault.retireCatalog(slug);
      }
      const roadmapFile = path.join(this.rootDir, 'ROADMAP.md');
      if (fs.existsSync(roadmapFile)) {
        await this.vault.syncMcNotes(mcNotes.distillRoadmap(fs.readFileSync(roadmapFile, 'utf8')));
      }
    } catch (err) {
      console.warn(`vault: ${err.message}`);
    }
  }

  vaultOp(fn) {
    if (!this.vaultEnabled() || !this.vault.ready) return;
    Promise.resolve()
      .then(fn)
      .catch((err) => console.warn(`vault: ${err.message}`));
  }

  // Everything MC knows about a project, as catalog-page input. Agents = the
  // registered agents with an instance on it; last activity = most recent
  // retained history event.
  catalogInfoFor(project, status = 'active') {
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      summary: project.description || project.name,
      registered: project.createdAt ? isoDay(project.createdAt) : null,
      lastActivity: this.lastActivityFor(project.id),
      agents: [...new Set(this.instancesOn(project.id).map((e) => e.agentId))],
      status,
    };
  }

  instancesOn(pid) {
    return [...this.instances.values()].filter((e) => e.projectId === pid);
  }

  lastActivityFor(pid) {
    let latest = 0;
    for (const ev of this.histories.get(pid) || []) {
      if (ev.ts > latest) latest = ev.ts;
    }
    return latest ? isoDay(latest) : null;
  }

  refreshProjectCatalog(project, status = 'active') {
    this.vaultOp(() => this.vault.refreshCatalog(this.catalogInfoFor(project, status)));
  }

  refreshCatalogFor(pid) {
    if (!pid) return;
    const project = this.findProject(pid);
    if (project) this.refreshProjectCatalog(project);
  }

  // What a run gets granted at spawn: the preamble (fleet catalog + this
  // project's page + the three rules) and an MCP server descriptor attributed
  // to agent + instance + conversation, so vault commits name the writer.
  vaultSpawnFor(iid) {
    const entry = this.instances.get(iid);
    if (!entry || !this.vaultEnabled() || !this.vault.ready) return null;
    try {
      const mcp = this.vault.mcpDescriptor({
        authorName: `agent/${entry.agentId}/${entry.id} (${entry.conversationId || 'new session'})`,
        authorEmail: `${entry.agentId}@mission-control`,
      });
      let configFile = null;
      return {
        preamble: this.vault.preambleFor(entry.projectId),
        mcp,
        configFile: () => (configFile ||= this.vault.writeMcpConfig(this.dataDir, entry.id, mcp)),
      };
    } catch (err) {
      console.warn(`vault: spawn context unavailable for ${iid}: ${err.message}`);
      return null;
    }
  }

  vaultStatus() {
    let stats = null;
    try {
      stats = this.vault.ready ? this.vault.stats() : null;
    } catch {}
    return {
      path: this.vault.dir,
      configured: !!((this.settingsAll._vault || {}).path || '').trim(),
      enabled: this.vaultEnabled(),
      ready: this.vault.ready,
      stats,
    };
  }

  async setVaultSettings(patch) {
    const next = { ...(this.settingsAll._vault || {}) };
    if (patch.path !== undefined) next.path = String(patch.path).trim();
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    this.settingsAll._vault = next;
    this.saveSettings();
    this.vault = new Vault(Vault.resolveDir(this.settingsAll, this.rootDir));
    await this.ensureVault();
    return this.vaultStatus();
  }

  /* ── Voice prompting (M16) ──────────────────────────────────────── */

  voiceConfig() {
    const v = this.settingsAll._voice || {};
    return { whisperKey: String(v.whisperKey || ''), whisperModel: String(v.whisperModel || '') };
  }

  updateVoice(patch) {
    const next = { ...(this.settingsAll._voice || {}) };
    if (patch.whisperKey !== undefined) next.whisperKey = String(patch.whisperKey).trim();
    if (patch.whisperModel !== undefined) next.whisperModel = String(patch.whisperModel).trim();
    this.settingsAll._voice = next;
    this.saveSettings();
    return this.voiceConfig();
  }

  requireVault() {
    if (!this.vaultEnabled()) throw httpError(400, 'The vault is disabled — enable it on the Vault page or via PUT /api/vault');
    if (!this.vault.ready) throw httpError(503, 'Vault is still initializing — try again in a moment');
    return this.vault;
  }

  /* ── History (project-owned) ───────────────────────────────────── */

  historyFile(pid) {
    return path.join(this.dataDir, `history-${pid}.json`);
  }

  historyFor(pid) {
    let events = this.histories.get(pid);
    if (!events) {
      events = readJson(this.historyFile(pid), []);
      this.histories.set(pid, events);
    }
    return events;
  }

  instanceHistory(iid) {
    const entry = this.get(iid);
    return this.historyFor(entry.projectId).filter((ev) => ev.iid === iid);
  }

  projectHistory(pid, { cid = null } = {}) {
    if (!this.findProject(pid)) throw httpError(404, 'Unknown project');
    const events = this.historyFor(pid);
    return cid ? events.filter((ev) => ev.cid === cid) : events;
  }

  // Every conversation that ran against a project, newest first: who ran it,
  // what it cost, how long it took.
  conversations(pid) {
    if (!this.findProject(pid)) throw httpError(404, 'Unknown project');
    const map = new Map();
    for (const ev of this.historyFor(pid)) {
      const cid = ev.cid || 's-0';
      let c = map.get(cid);
      if (!c) {
        c = {
          cid, pid, iid: ev.iid || null, agentId: ev.agentId || null,
          startedAt: ev.ts, endedAt: ev.ts, prompts: 0, runs: 0, failures: 0,
          cost: 0, estimated: 0, durationMs: 0, models: [], firstPrompt: null, origin: null,
        };
        map.set(cid, c);
      }
      if (ev.iid) c.iid = ev.iid;
      if (ev.agentId) c.agentId = ev.agentId;
      c.endedAt = ev.ts;
      if (ev.type === 'user_prompt') {
        c.prompts++;
        if (!c.firstPrompt) { c.firstPrompt = String(ev.text || '').slice(0, 200); c.origin = ev.origin || null; }
      } else if (ev.type === 'result') {
        c.runs++;
        if (failedResult(ev)) c.failures++;
        if (typeof ev.total_cost_usd === 'number') {
          c.cost += ev.total_cost_usd;
          c.estimated += ev.estimated_cost_usd ?? ev.total_cost_usd;
        }
        if (ev.duration_ms) c.durationMs += ev.duration_ms;
      } else if (ev.type === 'system' && ev.subtype === 'init' && ev.model && !c.models.includes(ev.model)) {
        c.models.push(ev.model);
      }
    }
    return [...map.values()].reverse().map((c) => {
      const inst = c.iid ? this.instances.get(c.iid) : null;
      const cfg = c.agentId ? this.findAgent(c.agentId) : null;
      return {
        ...c,
        agent: cfg ? cfg.name : c.agentId,
        accent: cfg ? cfg.accent : null,
        instance: inst ? inst.name : null,
        active: !!inst && inst.conversationId === c.cid,
      };
    });
  }

  pushEvent(iid, event) {
    const entry = this.get(iid);
    if (!entry.conversationId) entry.conversationId = 's-' + Date.now();
    const stamped = {
      ...event,
      ts: event.ts || Date.now(),
      cid: entry.conversationId,
      pid: entry.projectId,
      agentId: entry.agentId,
      iid: entry.id,
    };
    const history = this.historyFor(entry.projectId);
    history.push(stamped);
    if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
    if (typeof entry.adapter.skillsFromInit === 'function') {
      const names = entry.adapter.skillsFromInit(event);
      if (names) entry.reportedSkills = names;
    }
    this.scheduleInstancesSave();
    this.scheduleSave(entry.projectId);
    this.broadcast({ type: 'instance_event', iid, event: stamped });

    // Progress signal for the in-flight estimate: each tool call refines it.
    if (entry.run && stamped.type === 'assistant') {
      let calls = 0;
      for (const b of stamped.message?.content || []) if (b.type === 'tool_use') calls++;
      if (calls) {
        entry.run.toolCalls += calls;
        this.refineEstimate(entry.run);
        this.broadcastStatus(iid);
      }
    }

    // Kanban linkage: a dispatched card follows its run through the board.
    if (stamped.type === 'user_prompt' && stamped.taskId) {
      entry.currentTaskId = stamped.taskId;
      const task = this.tasks.find((t) => t.id === stamped.taskId);
      if (task) {
        task.cid = entry.conversationId;
        task.instanceId = iid;
        task.agentId = entry.agentId;
        task.column = 'inprogress';
        task.updatedAt = Date.now();
        this.saveTasks();
        this.broadcastTasks();
      }
    }
    if (entry.currentTaskId && stamped.type === 'result') {
      this.finalizeTask(entry, failedResult(stamped) ? 'error' : 'ok');
    } else if (entry.currentTaskId && stamped.type === 'error') {
      this.finalizeTask(entry, 'error');
    }

    // External notifications.
    if (this.notifier && stamped.type === 'result') {
      this.notifier.runFinished({
        agent: entry.name,
        task: entry.adapter.currentTask,
        durationMs: stamped.duration_ms,
        cost: stamped.total_cost_usd,
        failed: failedResult(stamped),
        queueLen: entry.queue.length,
        project: this.findProject(entry.projectId)?.name || null,
      });
      if (typeof stamped.total_cost_usd === 'number') this.notifier.addCost(stamped.total_cost_usd);
    } else if (this.notifier && stamped.type === 'error') {
      this.notifier.runError(entry.name, stamped.text);
    }

    // Fleet vault: a finished run stamps its project's catalog page (M13).
    if (stamped.type === 'result') this.refreshCatalogFor(stamped.pid);
  }

  scheduleSave(pid) {
    if (this.saveTimers.has(pid)) return;
    this.saveTimers.set(pid, setTimeout(() => {
      this.saveTimers.delete(pid);
      const events = this.histories.get(pid);
      if (!events) return;
      try {
        fs.writeFileSync(this.historyFile(pid), JSON.stringify(events));
      } catch (err) {
        console.warn(`Failed to save history for ${pid}:`, err.message);
      }
    }, 500));
  }

  clearSession(iid) {
    const entry = this.get(iid);
    entry.adapter.clearSession();
    entry.conversationId = 's-' + Date.now();
    this.pushEvent(iid, { type: 'meta', text: 'New session started' });
    this.broadcastStatus(iid);
  }

  // Drops this instance's conversations from the project's history.
  clearHistory(iid) {
    const entry = this.get(iid);
    const events = this.historyFor(entry.projectId);
    const kept = events.filter((ev) => ev.iid !== iid);
    events.splice(0, events.length, ...kept);
    entry.conversationId = 's-' + Date.now();
    this.saveInstances();
    this.scheduleSave(entry.projectId);
    this.broadcast({ type: 'history_cleared', iid, pid: entry.projectId });
    this.broadcastStatus(iid);
  }

  /* ── Chat + task queue ─────────────────────────────────────────── */

  makeOrigin(kind, taskId = null, via = null) {
    const origin = { kind };
    if (via) origin.via = via;
    if (taskId) {
      origin.taskId = taskId;
      const task = this.tasks.find((t) => t.id === taskId);
      if (task) origin.taskTitle = String(task.title).slice(0, 80);
    }
    return origin;
  }

  sendChat(iid, text, taskId = null, kind = 'chat') {
    const entry = this.get(iid);
    if (!text) throw httpError(400, 'Empty message');
    const origin = this.makeOrigin(kind, taskId);
    if (entry.adapter.isBusy()) {
      entry.queue.push({
        id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        text,
        queuedAt: Date.now(),
        origin,
        ...(taskId ? { taskId } : {}),
      });
      this.saveInstances();
      this.broadcastStatus(iid);
      return { queued: true, position: entry.queue.length };
    }
    this.startRun(iid, entry, text, taskId, origin);
    return { queued: false };
  }

  dispatchNext(iid) {
    const entry = this.instances.get(iid);
    if (!entry || entry.adapter.isBusy() || !entry.queue.length) return;
    const item = entry.queue.shift();
    this.saveInstances();
    const via = item.origin?.kind && item.origin.kind !== 'queue' ? item.origin.kind : 'chat';
    const origin = this.makeOrigin('queue', item.taskId || null, via);
    try {
      this.startRun(iid, entry, item.text, item.taskId || null, origin);
    } catch (err) {
      entry.run = null;
      this.pushEvent(iid, { type: 'error', text: 'Failed to start queued task: ' + err.message });
    }
    this.broadcastStatus(iid);
  }

  startRun(iid, entry, text, taskId, origin) {
    const stats = this.runStats(entry);
    entry.run = {
      origin,
      taskId: taskId || null,
      startedAt: Date.now(),
      toolCalls: 0,
      baselineMs: stats.medianMs,
      estimateMs: stats.medianMs,
      estimateBasis: stats.basis,
      estimateSamples: stats.samples,
      typicalToolCalls: stats.medianTools,
    };
    this.pushEvent(iid, { type: 'user_prompt', text, origin, ...(taskId ? { taskId } : {}) });
    entry.adapter.send(text);
  }

  // Duration baseline for a new run: the median of past completed runs by
  // this agent on the same project, then this agent anywhere, then the fleet.
  runStats(entry) {
    const collect = (matchAgent, matchPid) => {
      const runs = [];
      for (const [pid, events] of this.histories) {
        if (matchPid && pid !== entry.projectId) continue;
        const open = new Map(); // iid -> { tools, agentId }
        for (const ev of events) {
          const key = ev.iid || ev.agentId || '_';
          if (ev.type === 'user_prompt') { open.set(key, { tools: 0, agentId: ev.agentId }); continue; }
          const cur = open.get(key);
          if (!cur) continue;
          if (ev.type === 'assistant') {
            for (const b of ev.message?.content || []) if (b.type === 'tool_use') cur.tools++;
          } else if (ev.type === 'result' && ev.duration_ms > 0) {
            if (!failedResult(ev) && (!matchAgent || cur.agentId === entry.agentId)) runs.push({ ms: ev.duration_ms, tools: cur.tools });
            open.delete(key);
          }
        }
      }
      return runs;
    };
    const median = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    };
    const MIN_SAMPLES = 2;
    let runs = collect(true, true);
    let basis = 'project';
    if (runs.length < MIN_SAMPLES) { runs = collect(true, false); basis = 'agent'; }
    if (runs.length < MIN_SAMPLES) { runs = collect(false, false); basis = 'fleet'; }
    if (!runs.length) return { medianMs: null, medianTools: null, basis: null, samples: 0 };
    return {
      medianMs: median(runs.map((r) => r.ms)),
      medianTools: median(runs.map((r) => r.tools)),
      basis,
      samples: runs.length,
    };
  }

  refineEstimate(run) {
    const elapsed = Date.now() - run.startedAt;
    const base = run.baselineMs;
    if (run.toolCalls >= 3 && run.typicalToolCalls > 0) {
      const projected = elapsed * (run.typicalToolCalls / run.toolCalls);
      run.estimateMs = Math.round(base ? (base + projected) / 2 : projected);
    }
  }

  cancelQueued(iid, taskId) {
    const entry = this.get(iid);
    const before = entry.queue.length;
    entry.queue = entry.queue.filter((t) => t.id !== taskId);
    if (entry.queue.length === before) throw httpError(404, 'Task not found in queue');
    this.saveInstances();
    this.broadcastStatus(iid);
  }

  reorderQueue(iid, order) {
    const entry = this.get(iid);
    if (!Array.isArray(order)) throw httpError(400, 'order must be an array of task ids');
    const byId = new Map(entry.queue.map((t) => [t.id, t]));
    if (order.length !== entry.queue.length || !order.every((tid) => byId.has(tid))) {
      throw httpError(409, 'Queue changed — refresh and try again');
    }
    entry.queue = order.map((tid) => byId.get(tid));
    this.saveInstances();
    this.broadcastStatus(iid);
  }

  stop(iid) {
    this.get(iid).adapter.stop();
  }

  // Rollup for the daily email digest, per registered agent across projects.
  digestData(sinceTs) {
    const byAgent = new Map(this.registry.map((a) => [a.id, { name: a.name, runs: 0, failures: 0, cost: 0 }]));
    for (const events of this.histories.values()) {
      for (const ev of events) {
        if (ev.ts < sinceTs) continue;
        let a = byAgent.get(ev.agentId);
        if (!a) { a = { name: ev.agentId || 'unknown', runs: 0, failures: 0, cost: 0 }; byAgent.set(ev.agentId, a); }
        if (ev.type === 'result') {
          a.runs++;
          if (failedResult(ev)) a.failures++;
          a.cost += ev.total_cost_usd || 0;
        } else if (ev.type === 'error') a.failures++;
      }
    }
    const tasks = this.tasks
      .filter((t) => t.updatedAt >= sinceTs && ['review', 'done'].includes(t.column))
      .map((t) => ({
        title: t.title,
        column: t.column,
        project: t.projectId ? this.findProject(t.projectId)?.name : null,
      }));
    return { agents: [...byAgent.values()], tasks };
  }

  finalizeTask(entry, result) {
    const task = this.tasks.find((t) => t.id === entry.currentTaskId);
    entry.currentTaskId = null;
    if (!task) return;
    task.column = 'review';
    task.result = result;
    task.updatedAt = Date.now();
    this.saveTasks();
    this.broadcastTasks();
  }

  // Native Claude Code session ids owned by instances, so views of external
  // CLI sessions can exclude runs the dashboard itself started.
  managedSessionIds() {
    const ids = new Set();
    for (const e of this.instances.values()) {
      if (e.adapter.sessionId) ids.add(e.adapter.sessionId);
    }
    for (const events of this.histories.values()) {
      for (const ev of events) if (ev.session_id) ids.add(ev.session_id);
    }
    return ids;
  }

  saveState() {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.stateAll, null, 2));
  }

  saveSettings() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settingsAll, null, 2));
  }

  saveProjects() {
    fs.writeFileSync(this.projectsFile, JSON.stringify(this.projects, null, 2));
  }

  /* ── Kanban tasks ──────────────────────────────────────────────── */

  listTasks() {
    return [...this.tasks].sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  findTask(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw httpError(404, 'Unknown task');
    return task;
  }

  addTask({ projectId, title, description }) {
    title = String(title || '').trim();
    if (!title) throw httpError(400, 'Task title is required');
    projectId = projectId || null;
    if (projectId && !this.findProject(projectId)) throw httpError(404, 'Unknown project');
    const task = {
      id: 'k-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      projectId,
      title,
      description: String(description || ''),
      column: 'backlog',
      order: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      instanceId: null,
      agentId: null,
      cid: null,
      result: null,
    };
    this.tasks.push(task);
    this.saveTasks();
    this.broadcastTasks();
    return task;
  }

  updateTask(id, patch) {
    const task = this.findTask(id);
    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw httpError(400, 'Task title is required');
      task.title = title;
    }
    if (patch.description !== undefined) task.description = String(patch.description);
    if (patch.column !== undefined) {
      if (!['backlog', 'inprogress', 'review', 'done'].includes(patch.column)) {
        throw httpError(400, 'Invalid column');
      }
      if (task.column !== patch.column) {
        task.column = patch.column;
        task.order = Date.now();
        if (patch.column === 'backlog') task.result = null;
      }
    }
    task.updatedAt = Date.now();
    this.saveTasks();
    this.broadcastTasks();
    return task;
  }

  removeTask(id) {
    this.findTask(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.saveTasks();
    this.broadcastTasks();
  }

  // Send a card to an instance on the card's project; the card follows the
  // run through In progress → Review automatically.
  dispatchTask(taskId, instanceId) {
    const task = this.findTask(taskId);
    const entry = this.get(instanceId);
    if (!task.projectId) throw httpError(400, 'Move this card onto a project board before dispatching it');
    if (entry.projectId !== task.projectId) {
      throw httpError(409, `${entry.name} works on ${this.findProject(entry.projectId)?.name || 'another project'} — dispatch to an instance on ${this.findProject(task.projectId)?.name || 'this project'}`);
    }
    const prompt = task.description ? `${task.title}\n\n${task.description}` : task.title;
    const result = this.sendChat(instanceId, prompt, task.id, 'board');
    task.instanceId = instanceId;
    task.agentId = entry.agentId;
    task.column = 'inprogress';
    task.result = null;
    task.updatedAt = Date.now();
    this.saveTasks();
    this.broadcastTasks();
    return result;
  }

  saveTasks() {
    fs.writeFileSync(this.tasksFile, JSON.stringify(this.tasks, null, 2));
  }

  broadcastTasks() {
    this.broadcast({ type: 'tasks', tasks: this.listTasks() });
  }

  /* ── Projects ──────────────────────────────────────────────────── */

  findProject(pid) {
    return this.projects.find((p) => p.id === pid);
  }

  listProjects() {
    return this.projects.map((p) => {
      const on = this.instancesOn(p.id);
      return {
        ...p,
        instances: on.map((e) => e.id),
        agents: [...new Set(on.map((e) => e.agentId))],
      };
    });
  }

  normalizeProjectPath(raw) {
    let p = String(raw || '').trim();
    if (!p) throw httpError(400, 'Root folder is required');
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    fs.mkdirSync(p, { recursive: true });
    if (!fs.statSync(p).isDirectory()) throw httpError(400, 'Root folder is not a directory');
    return p;
  }

  addProject({ name, path: rawPath, description }) {
    name = String(name || '').trim();
    if (!name) throw httpError(400, 'Project name is required');
    const p = this.normalizeProjectPath(rawPath);
    let id = slugify(name, 'project');
    const base = id;
    let n = 2;
    while (this.findProject(id) || id.startsWith('_')) id = `${base}-${n++}`;
    const project = { id, name, path: p, description: String(description || ''), createdAt: Date.now() };
    this.projects.push(project);
    this.saveProjects();
    this.historyFor(id);
    this.broadcastProjects();
    this.refreshProjectCatalog(project);
    return project;
  }

  updateProject(id, patch) {
    const project = this.findProject(id);
    if (!project) throw httpError(404, 'Unknown project');
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw httpError(400, 'Project name is required');
      project.name = name;
    }
    if (patch.path !== undefined) project.path = this.normalizeProjectPath(patch.path);
    if (patch.description !== undefined) project.description = String(patch.description);
    this.saveProjects();
    this.broadcastProjects();
    for (const entry of this.instancesOn(id)) this.broadcastStatus(entry.id);
    this.refreshProjectCatalog(project);
    return project;
  }

  // Instances can't exist without their project, so removing one closes them
  // (refused while any is working). The history file stays on disk —
  // retirement over deletion, like the catalog page.
  removeProject(id) {
    const project = this.findProject(id);
    if (!project) throw httpError(404, 'Unknown project');
    for (const entry of this.instancesOn(id)) {
      if (entry.adapter.isBusy()) {
        throw httpError(409, `${entry.name} is working in this project — abort its run first`);
      }
    }
    for (const entry of this.instancesOn(id)) {
      entry.adapter.stop();
      entry.adapter.removeAllListeners();
      this.instances.delete(entry.id);
    }
    this.saveInstances();
    this.projects = this.projects.filter((p) => p.id !== id);
    this.saveProjects();
    this.histories.delete(id);
    this.broadcastInstances();
    this.broadcastProjects();
    // Orphaned cards move to the default-workspace board rather than vanishing.
    let moved = false;
    for (const t of this.tasks) {
      if (t.projectId === id) { t.projectId = null; moved = true; }
    }
    if (moved) {
      this.saveTasks();
      this.broadcastTasks();
    }
    this.vaultOp(() => this.vault.retireCatalog(id, project));
  }

  broadcastProjects() {
    this.broadcast({ type: 'projects', projects: this.listProjects() });
  }

  listSkills(iid) {
    const entry = this.get(iid);
    return entry.adapter.listSkills({ reported: entry.reportedSkills || [] });
  }

  getWorkspaceDir(entry) {
    const project = this.findProject(entry.projectId);
    if (project) {
      try { fs.mkdirSync(project.path, { recursive: true }); } catch {}
      return project.path;
    }
    return this.rootDir;
  }

  /* ── Prompt library ────────────────────────────────────────────── */

  listPrompts() {
    return this.prompts;
  }

  addPrompt({ name, text, projectId }) {
    name = String(name || '').trim();
    text = String(text || '').trim();
    if (!name || !text) throw httpError(400, 'Prompt name and text are required');
    projectId = projectId || null;
    if (projectId && !this.findProject(projectId)) throw httpError(404, 'Unknown project');
    const prompt = {
      id: 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name, text, projectId,
      createdAt: Date.now(),
    };
    this.prompts.push(prompt);
    this.savePrompts();
    return prompt;
  }

  updatePrompt(id, patch) {
    const prompt = this.prompts.find((p) => p.id === id);
    if (!prompt) throw httpError(404, 'Unknown prompt');
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw httpError(400, 'Prompt name is required');
      prompt.name = name;
    }
    if (patch.text !== undefined) {
      const text = String(patch.text).trim();
      if (!text) throw httpError(400, 'Prompt text is required');
      prompt.text = text;
    }
    if (patch.projectId !== undefined) prompt.projectId = patch.projectId || null;
    this.savePrompts();
    return prompt;
  }

  removePrompt(id) {
    if (!this.prompts.some((p) => p.id === id)) throw httpError(404, 'Unknown prompt');
    this.prompts = this.prompts.filter((p) => p.id !== id);
    this.savePrompts();
  }

  savePrompts() {
    fs.writeFileSync(this.promptsFile, JSON.stringify(this.prompts, null, 2));
  }

  /* ── Analytics ─────────────────────────────────────────────────── */

  // Rollup across the retained history window (last HISTORY_CAP events per
  // project). Agents are registered agents summed over every project.
  async analytics() {
    const now = Date.now();
    const pad = (n) => String(n).padStart(2, '0');
    const dayOf = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const days = [];
    const dayIndex = {};
    for (let i = 13; i >= 0; i--) {
      const key = dayOf(now - i * 864e5);
      dayIndex[key] = days.length;
      days.push({ date: key, cost: 0, estimated: 0, runs: 0, byAgent: {} });
    }
    const today = dayOf(now);
    const agentRows = new Map(this.registry.map((a) => [a.id, {
      id: a.id, name: a.name,
      runs: 0, failures: 0, cost: 0, estimated: 0, durSum: 0, maxMs: 0, tokensIn: 0, tokensOut: 0,
    }]));
    const projCost = {};
    let runs = 0, failures = 0, durSum = 0, durCount = 0;
    let todayCost = 0, weekCost = 0, todayEstimated = 0, weekEstimated = 0;

    for (const [pid, events] of this.histories) {
      const pc = (projCost[pid] ||= { cost: 0, estimated: 0, runs: 0, lastActivity: 0 });
      for (const ev of events) {
        if (ev.ts > pc.lastActivity) pc.lastActivity = ev.ts;
        if (ev.type !== 'result') continue;
        let a = agentRows.get(ev.agentId);
        if (!a) {
          a = { id: ev.agentId, name: ev.agentId || 'unknown', runs: 0, failures: 0, cost: 0, estimated: 0, durSum: 0, maxMs: 0, tokensIn: 0, tokensOut: 0 };
          agentRows.set(ev.agentId, a);
        }
        const cost = ev.total_cost_usd || 0;
        const est = typeof ev.estimated_cost_usd === 'number' ? ev.estimated_cost_usd : cost;
        const failed = failedResult(ev);
        a.runs++; runs++;
        if (failed) { a.failures++; failures++; }
        a.cost += cost; a.estimated += est;
        pc.cost += cost; pc.estimated += est; pc.runs++;
        if (ev.duration_ms) {
          a.durSum += ev.duration_ms;
          if (ev.duration_ms > a.maxMs) a.maxMs = ev.duration_ms;
          durSum += ev.duration_ms; durCount++;
        }
        const u = ev.usage || {};
        a.tokensIn += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        a.tokensOut += u.output_tokens || 0;
        const key = dayOf(ev.ts);
        if (key in dayIndex) {
          const day = days[dayIndex[key]];
          day.cost += cost; day.estimated += est;
          day.runs++;
          const by = (day.byAgent[a.name] ||= { cost: 0, estimated: 0 });
          by.cost += cost; by.estimated += est;
        }
        if (key === today) { todayCost += cost; todayEstimated += est; }
        if (now - ev.ts <= 7 * 864e5) { weekCost += cost; weekEstimated += est; }
      }
    }
    const agents = [...agentRows.values()].map((a) => ({ ...a, avgMs: a.runs && a.durSum ? a.durSum / a.runs : 0 }));

    const projects = [];
    for (const p of this.projects) {
      const pc = projCost[p.id] || { cost: 0, estimated: 0, runs: 0, lastActivity: 0 };
      const openTasks = { backlog: 0, inprogress: 0, review: 0, done: 0 };
      for (const t of this.tasks) {
        if ((t.projectId || null) === p.id) openTasks[t.column] = (openTasks[t.column] || 0) + 1;
      }
      let gitInfo = null;
      try {
        const s = await gitLib.status(p.path);
        gitInfo = s.isRepo ? { branch: s.branch, dirty: s.changes.length } : { notRepo: true };
      } catch {}
      projects.push({
        id: p.id,
        name: p.name,
        cost: pc.cost,
        estimated: pc.estimated,
        runs: pc.runs,
        lastActivity: pc.lastActivity || null,
        openTasks,
        agents: this.instancesOn(p.id).map((e) => e.name),
        git: gitInfo,
      });
    }

    return {
      totals: {
        todayCost, weekCost, todayEstimated, weekEstimated, runs, failures,
        successRate: runs ? (runs - failures) / runs : null,
        avgMs: durCount ? durSum / durCount : 0,
      },
      budget: { threshold: +(this.notifier?.config.events.costThreshold) || 0, todayCost },
      subscriptions: this.subscriptions(now),
      days,
      agents,
      projects,
    };
  }

  // Merged chronological activity feed across every project.
  feed(limit = 60) {
    const items = [];
    for (const [pid, events] of this.histories) {
      for (const ev of events) {
        let item = null;
        if (ev.type === 'user_prompt') item = { kind: 'start', text: String(ev.text || '').slice(0, 110), origin: ev.origin || null };
        else if (ev.type === 'result') {
          item = { kind: failedResult(ev) ? 'fail' : 'done', cost: ev.total_cost_usd, estimated: ev.estimated_cost_usd, durationMs: ev.duration_ms };
        } else if (ev.type === 'error') item = { kind: 'error', text: String(ev.text || '').slice(0, 110) };
        else if (ev.type === 'meta') item = { kind: 'meta', text: ev.text };
        if (item) {
          const inst = ev.iid ? this.instances.get(ev.iid) : null;
          const cfg = this.findAgent(ev.agentId);
          items.push({
            ...item,
            ts: ev.ts,
            iid: ev.iid || null,
            agentId: ev.agentId || null,
            agent: cfg ? cfg.name : (ev.agentId || 'unknown'),
            instance: inst ? inst.name : null,
            cid: ev.cid,
            pid,
          });
        }
      }
    }
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, limit);
  }

  /* ── Settings ──────────────────────────────────────────────────── */

  // Registered-agent defaults (settings.json, keyed by agent id).
  getAgentSettings(id) {
    const cfg = this.getAgent(id);
    const probe = this.ensureProbe(cfg);
    const schema = probe ? probe.settingsSchema() : [];
    const values = {};
    for (const field of schema) {
      const stored = (this.settingsAll[id] || {})[field.key];
      values[field.key] = stored !== undefined ? stored : field.default;
    }
    return { schema, values };
  }

  updateAgentSettings(id, values) {
    this.getAgent(id);
    this.settingsAll[id] = { ...(this.settingsAll[id] || {}), ...values };
    this.saveSettings();
    for (const e of this.instancesOf(id)) this.broadcastStatus(e.id);
    return this.getAgentSettings(id);
  }

  // Instance settings: the agent's defaults with this instance's overrides
  // (the Control Room model dropdown is per instance).
  getSettings(iid) {
    const entry = this.get(iid);
    const schema = entry.adapter.settingsSchema();
    const defaults = this.settingsAll[entry.agentId] || {};
    const values = {};
    for (const field of schema) {
      const stored = entry.settings[field.key] !== undefined ? entry.settings[field.key] : defaults[field.key];
      values[field.key] = stored !== undefined ? stored : field.default;
    }
    return { schema, values };
  }

  updateSettings(iid, values) {
    const entry = this.get(iid);
    entry.settings = { ...entry.settings, ...values };
    this.saveInstances();
    this.broadcastStatus(iid);
    return this.getSettings(iid);
  }

  /* ── Migration from the per-agent model ───────────────────────── */

  // One-time move from "every agent is a chat-able entry with its own history
  // file" to registry + instances + project-owned history. UI-created agents
  // from before are dropped with their history and workspace (Round 5:
  // start clean); built-in history is re-keyed by project, events with no
  // project stamp (default workspace) are dropped.
  migrateV1(config) {
    const configIds = new Set((config.agents || []).map((a) => a.id));
    const oldDynamic = readJson(this.registryFile, []).filter((a) => a && a.id && !configIds.has(a.id));
    for (const a of oldDynamic) {
      try { fs.rmSync(this.historyFile(a.id), { force: true }); } catch {}
      try { fs.rmSync(path.join(this.rootDir, a.workspace || `workspaces/${a.id}`), { recursive: true, force: true }); } catch {}
      delete this.settingsAll[a.id];
      delete this.stateAll[a.id];
    }
    const live = new Set(this.projects.map((p) => p.id));
    let migrated = 0;
    for (const id of configIds) {
      const file = this.historyFile(id);
      const events = readJson(file, null);
      if (!Array.isArray(events)) continue;
      for (const ev of events) {
        if (!ev.pid || !live.has(ev.pid)) continue;
        this.historyFor(ev.pid).push({ ...ev, agentId: id, iid: null });
        migrated++;
      }
      try { fs.renameSync(file, file + '.v1'); } catch {}
      delete this.stateAll[id];
    }
    for (const pid of this.histories.keys()) {
      const events = this.histories.get(pid);
      events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (events.length > HISTORY_CAP) events.splice(0, events.length - HISTORY_CAP);
      fs.writeFileSync(this.historyFile(pid), JSON.stringify(events));
    }
    for (const t of this.tasks) {
      if (t.instanceId === undefined) t.instanceId = null;
      if (t.agentId && !configIds.has(t.agentId)) t.agentId = null;
    }
    this.saveTasks();
    for (const key of Object.keys(this.stateAll)) if (!key.startsWith('_')) delete this.stateAll[key];
    this.stateAll._model = DATA_MODEL;
    this.saveState();
    this.saveSettings();
    fs.writeFileSync(this.registryFile, '[]');
    if (oldDynamic.length || migrated) {
      console.log(`Migrated to registry + instances: ${migrated} events re-keyed by project, ${oldDynamic.length} UI-created agent(s) dropped`);
    }
  }

  shutdown() {
    clearInterval(this.pollTimer);
    for (const entry of this.instances.values()) entry.adapter.stop();
    if (this.instancesTimer) this.saveInstances();
    for (const [pid, timer] of this.saveTimers) {
      clearTimeout(timer);
      try { fs.writeFileSync(this.historyFile(pid), JSON.stringify(this.histories.get(pid) || [])); } catch {}
    }
  }
}

module.exports = AgentManager;
