const fs = require('fs');
const os = require('os');
const path = require('path');
const adapters = require('./adapters');
const gitLib = require('./git');
const mcNotes = require('./mc-notes');
const Vault = require('./vault');

const HISTORY_CAP = 1000;
const ACCENTS = ['#d97757', '#5eb0ff', '#34d399', '#fbbf24', '#c084fc', '#f472b6'];

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
    // Per-agent runtime state: active project, per-project session pointers,
    // and the pending task queue — all survive server restarts.
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.stateAll = readJson(this.stateFile, {});
    // Agents created from the UI (as opposed to agents.config.js).
    this.dynamicFile = path.join(this.dataDir, 'agents.json');
    this.dynamicAgents = readJson(this.dynamicFile, []);
    // Kanban task cards.
    this.tasksFile = path.join(this.dataDir, 'tasks.json');
    this.tasks = readJson(this.tasksFile, []);
    // Prompt library.
    this.promptsFile = path.join(this.dataDir, 'prompts.json');
    this.prompts = readJson(this.promptsFile, []);
    this.saveTimers = new Map();
    this.agents = new Map();
    // Fleet vault: resolved from the reserved `_vault` key in settings.json
    // (default: a sibling of this repo). `ready` flips once initialized; until
    // then spawns go out without vault context.
    this.vault = new Vault(Vault.resolveDir(this.settingsAll, rootDir));

    for (const cfg of config.agents) this.registerAgent(cfg, false);
    for (const cfg of this.dynamicAgents) this.registerAgent(cfg, true);
  }

  registerAgent(cfg, dynamic) {
    const Adapter = adapters[cfg.type];
    if (!Adapter) {
      console.warn(`No adapter registered for type "${cfg.type}" (agent ${cfg.id}), skipping`);
      return null;
    }
    const workspaceDir = path.join(this.rootDir, cfg.workspace || `workspaces/${cfg.id}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const ctx = {
      workspaceDir,
      getWorkspaceDir: () => this.getWorkspaceDir(this.agents.get(cfg.id)),
      getSettings: () => this.settingsAll[cfg.id] || {},
      // Vault context granted at spawn: preamble + MCP server descriptor.
      getVaultSpawn: () => this.vaultSpawnFor(cfg.id),
    };
    const adapter = new Adapter(cfg, ctx);
    const entry = {
      config: { ...cfg, dynamic },
      adapter,
      workspaceDir,
      history: readJson(this.historyFile(cfg.id), []),
      projectId: null,
      conversationId: null,
      queue: [],
    };

    // Migrate any pre-session-tracking events into a single legacy session.
    if (entry.history.length && !entry.history.some((ev) => ev.cid)) {
      for (const ev of entry.history) ev.cid = 's-0';
    }

    // Restore active project, session continuity, and pending queue.
    const ast = this.stateAll[cfg.id] || {};
    entry.projectId = ast.projectId && this.findProject(ast.projectId) ? ast.projectId : null;
    entry.queue = Array.isArray(ast.queue) ? ast.queue : [];
    const saved = (ast.byProject || {})[entry.projectId || '_default'];
    if (saved) {
      adapter.sessionId = saved.sessionId || null;
      entry.conversationId = saved.cid || null;
    } else {
      for (const ev of entry.history) if (ev.cid) entry.conversationId = ev.cid;
      for (let i = entry.history.length - 1; i >= 0; i--) {
        if (entry.history[i].session_id) { adapter.sessionId = entry.history[i].session_id; break; }
      }
    }
    for (let i = entry.history.length - 1; i >= 0; i--) {
      const ev = entry.history[i];
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) { adapter.model = ev.model; break; }
    }
    // Skill names the CLI reported, kept with the session pointer because the
    // init event that carried them is soon trimmed out of history.
    entry.reportedSkills = (saved && Array.isArray(saved.skills)) ? saved.skills : null;
    if (!entry.reportedSkills && typeof adapter.skillsFromInit === 'function') {
      for (let i = entry.history.length - 1; i >= 0 && !entry.reportedSkills; i--) {
        entry.reportedSkills = adapter.skillsFromInit(entry.history[i]);
      }
    }
    // Stored results were priced with whatever config was live at the time;
    // re-derive so a pricing change (or a newly added rate card) applies to
    // the retained history too.
    if (cfg.pricing && typeof adapter.reprice === 'function') {
      for (const ev of entry.history) if (ev.type === 'result') adapter.reprice(ev);
    }

    adapter.on('status', () => {
      // The run record lives exactly as long as the adapter is working.
      if (!adapter.isBusy()) entry.run = null;
      const status = this.statusOf(entry);
      this.broadcast({ type: 'agent_status', agentId: cfg.id, status });
      const prevState = entry.lastState;
      entry.lastState = status.state;
      if (this.notifier && prevState && prevState !== 'offline' && status.state === 'offline') {
        this.notifier.agentOffline(cfg.name);
      }
      // An aborted run ends without a result event — park its card in Review.
      if (status.state === 'online' && entry.currentTaskId) {
        this.finalizeTask(entry, 'stopped');
      }
      // Drain the queue whenever the agent comes free.
      if (status.state === 'online' && entry.queue.length && !adapter.isBusy()) {
        setTimeout(() => this.dispatchNext(cfg.id), 400);
      }
    });
    adapter.on('event', (event) => this.pushEvent(cfg.id, event));
    adapter.on('partial', ({ text }) => {
      this.broadcast({ type: 'agent_partial', agentId: cfg.id, text });
    });
    this.agents.set(cfg.id, entry);
    return entry;
  }

  init() {
    this.pollAvailability();
    this.pollTimer = setInterval(() => this.pollAvailability(), 20000);
    this.ensureVault();
  }

  /* ── Fleet vault ───────────────────────────────────────────────── */

  vaultEnabled() {
    return (this.settingsAll._vault || {}).enabled !== false;
  }

  // Initialize the vault on boot, then reconcile the catalog with live
  // project data (M13): refresh every registered project's page and retire
  // pages whose project went away (e.g. unregistered while the vault was
  // disabled). Finish by distilling the roadmap's planning decisions into
  // `_mc/` notes.
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

  // Fire-and-forget vault maintenance: it must never break the request path
  // it rides on. Ops dropped before the vault is ready (first-boot init is
  // async) are re-covered by the boot reconciliation above.
  vaultOp(fn) {
    if (!this.vaultEnabled() || !this.vault.ready) return;
    Promise.resolve()
      .then(fn)
      .catch((err) => console.warn(`vault: ${err.message}`));
  }

  // Everything MC knows about a project, as catalog-page input. Harness
  // details (M9's summary, once it ships) join here; until then the page
  // carries name / path / agents. Last activity = most recent retained
  // history event stamped with that project.
  catalogInfoFor(project, status = 'active') {
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      summary: project.description || project.name,
      registered: project.createdAt ? isoDay(project.createdAt) : null,
      lastActivity: this.lastActivityFor(project.id),
      agents: [...this.agents.values()].filter((e) => e.projectId === project.id).map((e) => e.config.id),
      status,
    };
  }

  lastActivityFor(pid) {
    let latest = 0;
    for (const e of this.agents.values()) {
      for (const ev of e.history) {
        if (ev.pid === pid && ev.ts > latest) latest = ev.ts;
      }
    }
    return latest ? isoDay(latest) : null;
  }

  refreshProjectCatalog(project, status = 'active') {
    this.vaultOp(() => this.vault.refreshCatalog(this.catalogInfoFor(project, status)));
  }

  // By-id variant used from event paths; unknown/null (default workspace,
  // already-unregistered project) is a no-op.
  refreshCatalogFor(pid) {
    if (!pid) return;
    const project = this.findProject(pid);
    if (project) this.refreshProjectCatalog(project);
  }

  // What a run gets granted at spawn: the preamble (fleet catalog + this
  // project's page + the three rules) and an MCP server descriptor attributed
  // to this agent + conversation, so vault commits name the writer. Null while
  // the vault is disabled or not yet initialized.
  vaultSpawnFor(id) {
    const entry = this.agents.get(id);
    if (!entry || !this.vaultEnabled() || !this.vault.ready) return null;
    try {
      const mcp = this.vault.mcpDescriptor({
        authorName: `agent/${entry.config.id} (${entry.conversationId || 'new session'})`,
        authorEmail: `${entry.config.id}@mission-control`,
      });
      let configFile = null;
      return {
        preamble: this.vault.preambleFor(entry.projectId),
        mcp,
        // CLIs that need an MCP config *file* (not an inline flag) get one,
        // written lazily so runs without vault support don't litter the disk.
        configFile: () => (configFile ||= this.vault.writeMcpConfig(this.dataDir, entry.config.id, mcp)),
      };
    } catch (err) {
      console.warn(`vault: spawn context unavailable for ${id}: ${err.message}`);
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
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settingsAll, null, 2));
    this.vault = new Vault(Vault.resolveDir(this.settingsAll, this.rootDir));
    await this.ensureVault();
    return this.vaultStatus();
  }

  /* ── Voice prompting (M16) ──────────────────────────────────────── */

  // Whisper settings live under the reserved `_voice` key in settings.json,
  // mirroring `_vault`. Browser dictation has no settings — it needs no key.
  voiceConfig() {
    const v = this.settingsAll._voice || {};
    return { whisperKey: String(v.whisperKey || ''), whisperModel: String(v.whisperModel || '') };
  }

  updateVoice(patch) {
    const next = { ...(this.settingsAll._voice || {}) };
    if (patch.whisperKey !== undefined) next.whisperKey = String(patch.whisperKey).trim();
    if (patch.whisperModel !== undefined) next.whisperModel = String(patch.whisperModel).trim();
    this.settingsAll._voice = next;
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settingsAll, null, 2));
    return this.voiceConfig();
  }

  // Guard for the dashboard's vault-browser routes (M14): one consistent
  // disabled/not-ready answer instead of every route guessing.
  requireVault() {
    if (!this.vaultEnabled()) {
      const err = new Error('The vault is disabled — enable it on the Vault page or via PUT /api/vault');
      err.status = 400;
      throw err;
    }
    if (!this.vault.ready) {
      const err = new Error('Vault is still initializing — try again in a moment');
      err.status = 503;
      throw err;
    }
    return this.vault;
  }

  async pollAvailability() {
    for (const entry of this.agents.values()) {
      try {
        await entry.adapter.refreshAvailability();
      } catch {}
    }
  }

  historyFile(id) {
    return path.join(this.dataDir, `history-${id}.json`);
  }

  get(id) {
    const entry = this.agents.get(id);
    if (!entry) throw httpError(404, 'Unknown agent');
    return entry;
  }

  statusOf(entry) {
    const status = entry.adapter.getStatus();
    const project = entry.projectId ? this.findProject(entry.projectId) : null;
    status.project = project ? { id: project.id, name: project.name, path: project.path } : null;
    status.cid = entry.conversationId;
    status.queue = entry.queue.map((t) => ({ id: t.id, text: t.text, queuedAt: t.queuedAt, origin: t.origin || null }));
    status.run = entry.run || null;
    return status;
  }

  broadcastStatus(id) {
    const entry = this.agents.get(id);
    if (!entry) return;
    this.broadcast({ type: 'agent_status', agentId: id, status: this.statusOf(entry) });
  }

  // Config as exposed to the browser: `env` may hold provider secrets, so only
  // the fact that an agent has a custom environment is sent, never its values.
  publicConfig(cfg) {
    const { env, ...rest } = cfg;
    return env && Object.keys(env).length ? { ...rest, customEnv: Object.keys(env) } : rest;
  }

  list() {
    return [...this.agents.values()].map((e) => ({
      ...this.publicConfig(e.config),
      status: this.statusOf(e),
    }));
  }

  /* ── Dynamic agents ────────────────────────────────────────────── */

  agentTypes() {
    return Object.entries(adapters).map(([type, Adapter]) => ({
      type,
      label: Adapter.displayName || type,
    }));
  }

  addAgent({ name, type, description }) {
    name = String(name || '').trim();
    if (!name) throw httpError(400, 'Agent name is required');
    type = String(type || 'claude-code');
    if (!adapters[type]) throw httpError(400, `Unknown agent type "${type}"`);
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    const base = id;
    let n = 2;
    while (this.agents.has(id)) id = `${base}-${n++}`;
    const cfg = {
      id,
      name,
      type,
      description: String(description || '') || `${adapters[type].displayName || type} instance`,
      accent: ACCENTS[this.agents.size % ACCENTS.length],
      workspace: `workspaces/${id}`,
      createdAt: Date.now(),
    };
    this.dynamicAgents.push(cfg);
    this.saveDynamicAgents();
    const entry = this.registerAgent(cfg, true);
    if (!entry) throw httpError(500, 'Failed to create agent');
    entry.adapter.refreshAvailability();
    this.broadcastAgents();
    return { ...this.publicConfig(entry.config), status: this.statusOf(entry) };
  }

  removeAgent(id) {
    const entry = this.get(id);
    if (!entry.config.dynamic) throw httpError(400, 'Built-in agents cannot be retired (edit agents.config.js instead)');
    if (entry.adapter.isBusy()) throw httpError(409, 'Agent is busy — abort its run first');
    entry.adapter.stop();
    entry.adapter.removeAllListeners();
    this.agents.delete(id);
    this.dynamicAgents = this.dynamicAgents.filter((a) => a.id !== id);
    this.saveDynamicAgents();
    delete this.stateAll[id];
    this.saveState();
    delete this.settingsAll[id];
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settingsAll, null, 2));
    try { fs.rmSync(this.historyFile(id), { force: true }); } catch {}
    this.broadcastAgents();
  }

  saveDynamicAgents() {
    fs.writeFileSync(this.dynamicFile, JSON.stringify(this.dynamicAgents, null, 2));
  }

  broadcastAgents() {
    this.broadcast({ type: 'agents', agents: this.list() });
  }

  /* ── Chat + task queue ─────────────────────────────────────────── */

  // Where a run came from. `kind` is chat | board | queue; a queued run keeps
  // the kind it was submitted with in `via`. Card titles are copied in so the
  // origin still reads well after the card is deleted.
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

  sendChat(id, text, taskId = null, kind = 'chat') {
    const entry = this.get(id);
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
      this.saveQueue(id, entry);
      this.broadcastStatus(id);
      return { queued: true, position: entry.queue.length };
    }
    this.startRun(id, entry, text, taskId, origin);
    return { queued: false };
  }

  dispatchNext(id) {
    const entry = this.agents.get(id);
    if (!entry || entry.adapter.isBusy() || !entry.queue.length) return;
    const item = entry.queue.shift();
    this.saveQueue(id, entry);
    const via = item.origin?.kind && item.origin.kind !== 'queue' ? item.origin.kind : 'chat';
    const origin = this.makeOrigin('queue', item.taskId || null, via);
    try {
      this.startRun(id, entry, item.text, item.taskId || null, origin);
    } catch (err) {
      entry.run = null;
      this.pushEvent(id, { type: 'error', text: 'Failed to start queued task: ' + err.message });
    }
    this.broadcastStatus(id);
  }

  // Begin a run: record its origin and estimate, log the prompt, hand the text
  // to the adapter. The run record is exposed in status while the adapter is
  // busy and dropped as soon as it goes idle.
  startRun(id, entry, text, taskId, origin) {
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
    this.pushEvent(id, { type: 'user_prompt', text, origin, ...(taskId ? { taskId } : {}) });
    entry.adapter.send(text);
  }

  // Duration baseline for a new run: the median of past completed runs by this
  // agent on the same project, falling back to the agent's runs anywhere, then
  // to every agent. Also yields the typical tool-call count, used to refine
  // the estimate while the run is in flight.
  runStats(entry) {
    const pid = entry.projectId || null;
    const collect = (entries, matchPid) => {
      const runs = [];
      for (const e of entries) {
        let tools = 0;
        let started = null;
        for (const ev of e.history) {
          if (ev.type === 'user_prompt') { tools = 0; started = ev; continue; }
          if (ev.type === 'assistant') {
            for (const b of ev.message?.content || []) if (b.type === 'tool_use') tools++;
          } else if (ev.type === 'result' && ev.duration_ms > 0) {
            const failed = ev.is_error || (ev.subtype && ev.subtype !== 'success');
            if (!failed && (!matchPid || (started?.pid || null) === pid)) runs.push({ ms: ev.duration_ms, tools });
            started = null;
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
    let runs = collect([entry], true);
    let basis = 'project';
    if (runs.length < MIN_SAMPLES) { runs = collect([entry], false); basis = 'agent'; }
    if (runs.length < MIN_SAMPLES) { runs = collect([...this.agents.values()], false); basis = 'fleet'; }
    if (!runs.length) return { medianMs: null, medianTools: null, basis: null, samples: 0 };
    return {
      medianMs: median(runs.map((r) => r.ms)),
      medianTools: median(runs.map((r) => r.tools)),
      basis,
      samples: runs.length,
    };
  }

  // Live refinement: once a few tool calls are in, project the total from how
  // far through the typical tool-call count we are, and blend with the
  // baseline so a single fast or slow step doesn't swing the number.
  refineEstimate(run) {
    const elapsed = Date.now() - run.startedAt;
    const base = run.baselineMs;
    if (run.toolCalls >= 3 && run.typicalToolCalls > 0) {
      const projected = elapsed * (run.typicalToolCalls / run.toolCalls);
      run.estimateMs = Math.round(base ? (base + projected) / 2 : projected);
    }
  }

  cancelQueued(id, taskId) {
    const entry = this.get(id);
    const before = entry.queue.length;
    entry.queue = entry.queue.filter((t) => t.id !== taskId);
    if (entry.queue.length === before) throw httpError(404, 'Task not found in queue');
    this.saveQueue(id, entry);
    this.broadcastStatus(id);
  }

  reorderQueue(id, order) {
    const entry = this.get(id);
    if (!Array.isArray(order)) throw httpError(400, 'order must be an array of task ids');
    const byId = new Map(entry.queue.map((t) => [t.id, t]));
    if (order.length !== entry.queue.length || !order.every((tid) => byId.has(tid))) {
      throw httpError(409, 'Queue changed — refresh and try again');
    }
    entry.queue = order.map((tid) => byId.get(tid));
    this.saveQueue(id, entry);
    this.broadcastStatus(id);
  }

  saveQueue(id, entry) {
    (this.stateAll[id] ||= {}).queue = entry.queue;
    this.saveState();
  }

  stop(id) {
    this.get(id).adapter.stop();
  }

  clearSession(id) {
    const entry = this.get(id);
    entry.adapter.clearSession();
    entry.conversationId = 's-' + Date.now();
    this.pushEvent(id, { type: 'meta', text: 'New session started' });
  }

  clearHistory(id) {
    const entry = this.get(id);
    entry.history = [];
    entry.conversationId = null;
    this.scheduleSave(id);
    this.broadcast({ type: 'history_cleared', agentId: id });
  }

  pushEvent(id, event) {
    const entry = this.get(id);
    if (!entry.conversationId) entry.conversationId = 's-' + Date.now();
    const stamped = {
      ...event,
      ts: event.ts || Date.now(),
      cid: entry.conversationId,
      pid: entry.projectId || null,
    };
    entry.history.push(stamped);
    if (entry.history.length > HISTORY_CAP) {
      entry.history.splice(0, entry.history.length - HISTORY_CAP);
    }
    if (typeof entry.adapter.skillsFromInit === 'function') {
      const names = entry.adapter.skillsFromInit(event);
      if (names) entry.reportedSkills = names;
    }
    this.rememberPointer(id, entry);
    this.scheduleSave(id);
    this.broadcast({ type: 'agent_event', agentId: id, event: stamped });

    // Progress signal for the in-flight estimate: each tool call refines it.
    if (entry.run && stamped.type === 'assistant') {
      let calls = 0;
      for (const b of stamped.message?.content || []) if (b.type === 'tool_use') calls++;
      if (calls) {
        entry.run.toolCalls += calls;
        this.refineEstimate(entry.run);
        this.broadcastStatus(id);
      }
    }

    // Kanban linkage: a dispatched card follows its run through the board.
    if (stamped.type === 'user_prompt' && stamped.taskId) {
      entry.currentTaskId = stamped.taskId;
      const task = this.tasks.find((t) => t.id === stamped.taskId);
      if (task) {
        task.cid = entry.conversationId;
        task.agentId = id;
        task.column = 'inprogress';
        task.updatedAt = Date.now();
        this.saveTasks();
        this.broadcastTasks();
      }
    }
    if (entry.currentTaskId && stamped.type === 'result') {
      const failed = stamped.is_error || (stamped.subtype && stamped.subtype !== 'success');
      this.finalizeTask(entry, failed ? 'error' : 'ok');
    } else if (entry.currentTaskId && stamped.type === 'error') {
      this.finalizeTask(entry, 'error');
    }

    // External notifications.
    if (this.notifier && stamped.type === 'result') {
      const failed = stamped.is_error || (stamped.subtype && stamped.subtype !== 'success');
      this.notifier.runFinished({
        agent: entry.config.name,
        task: entry.adapter.currentTask,
        durationMs: stamped.duration_ms,
        cost: stamped.total_cost_usd,
        failed,
        queueLen: entry.queue.length,
        project: entry.projectId ? this.findProject(entry.projectId)?.name : null,
      });
      if (typeof stamped.total_cost_usd === 'number') this.notifier.addCost(stamped.total_cost_usd);
    } else if (this.notifier && stamped.type === 'error') {
      this.notifier.runError(entry.config.name, stamped.text);
    }

    // Fleet vault: a finished run stamps its project's catalog page with the
    // day's activity. The stamp is day-granular, so the refresh writes at
    // most once per project per day (M13).
    if (stamped.type === 'result') this.refreshCatalogFor(stamped.pid);
  }

  // Rollup for the daily email digest.
  digestData(sinceTs) {
    const agents = [...this.agents.values()].map((e) => {
      const events = e.history.filter((ev) => ev.ts >= sinceTs);
      const results = events.filter((ev) => ev.type === 'result');
      return {
        name: e.config.name,
        runs: results.length,
        failures:
          results.filter((ev) => ev.is_error || (ev.subtype && ev.subtype !== 'success')).length +
          events.filter((ev) => ev.type === 'error').length,
        cost: results.reduce((s, ev) => s + (ev.total_cost_usd || 0), 0),
      };
    });
    const tasks = this.tasks
      .filter((t) => t.updatedAt >= sinceTs && ['review', 'done'].includes(t.column))
      .map((t) => ({
        title: t.title,
        column: t.column,
        project: t.projectId ? this.findProject(t.projectId)?.name : null,
      }));
    return { agents, tasks };
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

  // Native Claude Code session ids owned by managed agents — current adapter
  // sessions plus saved per-project pointers — so views of external CLI
  // sessions can exclude runs the dashboard itself started.
  managedSessionIds() {
    const ids = new Set();
    for (const e of this.agents.values()) {
      if (e.adapter.sessionId) ids.add(e.adapter.sessionId);
    }
    for (const ast of Object.values(this.stateAll)) {
      for (const saved of Object.values(ast.byProject || {})) {
        if (saved?.sessionId) ids.add(saved.sessionId);
      }
    }
    return ids;
  }

  rememberPointer(id, entry) {
    const st = (this.stateAll[id] ||= {});
    st.projectId = entry.projectId;
    (st.byProject ||= {})[entry.projectId || '_default'] = {
      sessionId: entry.adapter.sessionId,
      cid: entry.conversationId,
      skills: entry.reportedSkills || undefined,
    };
    this.saveState();
  }

  scheduleSave(id) {
    if (this.saveTimers.has(id)) return;
    this.saveTimers.set(id, setTimeout(() => {
      this.saveTimers.delete(id);
      const entry = this.agents.get(id);
      if (!entry) return;
      try {
        fs.writeFileSync(this.historyFile(id), JSON.stringify(entry.history));
      } catch (err) {
        console.warn(`Failed to save history for ${id}:`, err.message);
      }
    }, 500));
  }

  saveState() {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.stateAll, null, 2));
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

  // Send a card to an agent: point the agent at the card's project (when idle),
  // then run or queue the card's prompt. The card follows the run through
  // In progress → Review automatically.
  dispatchTask(taskId, agentId) {
    const task = this.findTask(taskId);
    const entry = this.get(agentId);
    if ((entry.projectId || null) !== (task.projectId || null)) {
      if (entry.adapter.isBusy()) {
        throw httpError(409, `${entry.config.name} is busy in a different project — wait for it to finish or abort first`);
      }
      this.setAgentProject(agentId, task.projectId);
    }
    const prompt = task.description ? `${task.title}\n\n${task.description}` : task.title;
    const result = this.sendChat(agentId, prompt, task.id, 'board');
    task.agentId = agentId;
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
    return this.projects.map((p) => ({
      ...p,
      agents: [...this.agents.values()]
        .filter((e) => e.projectId === p.id)
        .map((e) => e.config.id),
    }));
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
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const base = id;
    let n = 2;
    while (this.findProject(id)) id = `${base}-${n++}`;
    const project = { id, name, path: p, description: String(description || ''), createdAt: Date.now() };
    this.projects.push(project);
    this.saveProjects();
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
    for (const entry of this.agents.values()) {
      if (entry.projectId === id) this.broadcastStatus(entry.config.id);
    }
    this.refreshProjectCatalog(project);
    return project;
  }

  removeProject(id) {
    const project = this.findProject(id);
    if (!project) throw httpError(404, 'Unknown project');
    for (const entry of this.agents.values()) {
      if (entry.projectId === id && entry.adapter.isBusy()) {
        throw httpError(409, `${entry.config.name} is working in this project — abort its run first`);
      }
    }
    for (const entry of this.agents.values()) {
      if (entry.projectId === id) this.setAgentProject(entry.config.id, null);
    }
    this.projects = this.projects.filter((p) => p.id !== id);
    this.saveProjects();
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
    // Retirement over deletion (M13): the catalog page stays, marked retired.
    this.vaultOp(() => this.vault.retireCatalog(id, project));
  }

  broadcastProjects() {
    this.broadcast({ type: 'projects', projects: this.listProjects() });
  }

  // Point an agent at a project (or null = default workspace). Saves the current
  // session pointer and restores the one previously used for that project, so
  // switching back resumes the earlier conversation.
  setAgentProject(id, projectId) {
    const entry = this.get(id);
    if (entry.adapter.isBusy()) throw httpError(409, 'Agent is busy — abort the current run first');
    const project = projectId ? this.findProject(projectId) : null;
    if (projectId && !project) throw httpError(404, 'Unknown project');
    if ((entry.projectId || null) === (project ? project.id : null)) return;

    this.rememberPointer(id, entry);
    const previous = entry.projectId;
    entry.projectId = project ? project.id : null;
    const saved = ((this.stateAll[id] || {}).byProject || {})[entry.projectId || '_default'] || {};
    entry.adapter.sessionId = saved.sessionId || null;
    entry.conversationId = saved.cid || null;
    entry.reportedSkills = Array.isArray(saved.skills) ? saved.skills : null;
    this.rememberPointer(id, entry);

    this.pushEvent(id, {
      type: 'meta',
      text: project
        ? `Pointed at project "${project.name}" (${project.path})${saved.sessionId ? ' — resuming previous session' : ' — fresh session'}`
        : 'Pointed at default workspace',
    });
    this.broadcastStatus(id);
    this.broadcastProjects();
    // Both projects' agent lists changed (M13 catalog refresh).
    this.refreshCatalogFor(previous);
    this.refreshCatalogFor(entry.projectId);
  }

  listSkills(id) {
    const entry = this.get(id);
    return entry.adapter.listSkills({ reported: entry.reportedSkills || [] });
  }

  getWorkspaceDir(entry) {
    if (entry.projectId) {
      const project = this.findProject(entry.projectId);
      if (project && fs.existsSync(project.path)) return project.path;
    }
    return entry.workspaceDir;
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

  // Rollup across the retained history window (last HISTORY_CAP events/agent).
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
    const agents = [];
    const projCost = {};
    let runs = 0, failures = 0, durSum = 0, durCount = 0;
    let todayCost = 0, weekCost = 0, todayEstimated = 0, weekEstimated = 0;

    for (const e of this.agents.values()) {
      const a = {
        id: e.config.id, name: e.config.name,
        runs: 0, failures: 0, cost: 0, estimated: 0, durSum: 0, maxMs: 0, tokensIn: 0, tokensOut: 0,
      };
      for (const ev of e.history) {
        const pid = ev.pid || null;
        const pc = (projCost[pid] ||= { cost: 0, estimated: 0, runs: 0, lastActivity: 0 });
        if (ev.ts > pc.lastActivity) pc.lastActivity = ev.ts;
        if (ev.type !== 'result') continue;
        // `cost` is what was actually billed; `est` is the same run at list
        // price, which only differs for subscription-backed agents with a
        // rate card configured.
        const cost = ev.total_cost_usd || 0;
        const est = typeof ev.estimated_cost_usd === 'number' ? ev.estimated_cost_usd : cost;
        const failed = ev.is_error || (ev.subtype && ev.subtype !== 'success');
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
          const by = (day.byAgent[e.config.name] ||= { cost: 0, estimated: 0 });
          by.cost += cost; by.estimated += est;
        }
        if (key === today) { todayCost += cost; todayEstimated += est; }
        if (now - ev.ts <= 7 * 864e5) { weekCost += cost; weekEstimated += est; }
      }
      a.avgMs = a.runs && a.durSum ? a.durSum / a.runs : 0;
      agents.push(a);
    }

    const projects = [];
    for (const p of [...this.projects, null]) {
      const pid = p ? p.id : null;
      const pc = projCost[pid] || { cost: 0, estimated: 0, runs: 0, lastActivity: 0 };
      const openTasks = { backlog: 0, inprogress: 0, review: 0, done: 0 };
      for (const t of this.tasks) {
        if ((t.projectId || null) === pid) openTasks[t.column] = (openTasks[t.column] || 0) + 1;
      }
      let gitInfo = null;
      if (p) {
        try {
          const s = await gitLib.status(p.path);
          gitInfo = s.isRepo ? { branch: s.branch, dirty: s.changes.length } : { notRepo: true };
        } catch {}
      }
      projects.push({
        id: pid,
        name: p ? p.name : 'Default workspace',
        cost: pc.cost,
        estimated: pc.estimated,
        runs: pc.runs,
        lastActivity: pc.lastActivity || null,
        openTasks,
        agents: [...this.agents.values()].filter((e) => (e.projectId || null) === pid).map((e) => e.config.name),
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
      days,
      agents,
      projects,
    };
  }

  // Merged chronological activity feed across all agents.
  feed(limit = 60) {
    const items = [];
    for (const e of this.agents.values()) {
      for (const ev of e.history) {
        let item = null;
        if (ev.type === 'user_prompt') item = { kind: 'start', text: String(ev.text || '').slice(0, 110), origin: ev.origin || null };
        else if (ev.type === 'result') {
          const failed = ev.is_error || (ev.subtype && ev.subtype !== 'success');
          item = { kind: failed ? 'fail' : 'done', cost: ev.total_cost_usd, estimated: ev.estimated_cost_usd, durationMs: ev.duration_ms };
        } else if (ev.type === 'error') item = { kind: 'error', text: String(ev.text || '').slice(0, 110) };
        else if (ev.type === 'meta') item = { kind: 'meta', text: ev.text };
        if (item) {
          items.push({ ...item, ts: ev.ts, agentId: e.config.id, agent: e.config.name, pid: ev.pid || null });
        }
      }
    }
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, limit);
  }

  /* ── Settings ──────────────────────────────────────────────────── */

  getSettings(id) {
    const entry = this.get(id);
    const schema = entry.adapter.settingsSchema();
    const values = {};
    for (const field of schema) {
      const stored = (this.settingsAll[id] || {})[field.key];
      values[field.key] = stored !== undefined ? stored : field.default;
    }
    return { schema, values };
  }

  updateSettings(id, values) {
    this.get(id);
    this.settingsAll[id] = { ...(this.settingsAll[id] || {}), ...values };
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settingsAll, null, 2));
    this.broadcastStatus(id);
    return this.getSettings(id);
  }

  shutdown() {
    clearInterval(this.pollTimer);
    for (const entry of this.agents.values()) entry.adapter.stop();
  }
}

module.exports = AgentManager;
