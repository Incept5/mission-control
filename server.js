const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const AgentManager = require('./lib/agent-manager');
const files = require('./lib/files');
const git = require('./lib/git');
const Notifier = require('./lib/notify');
const claudeStore = require('./lib/claude-store');
const cliSessions = require('./lib/cli-sessions');
const voice = require('./lib/voice');
const agentsConfig = require('./agents.config');

const PORT = process.env.PORT || 1969;

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

const manager = new AgentManager(agentsConfig, broadcast, process.env.MC_ROOT || __dirname);
const notifier = new Notifier(path.join(__dirname, 'data'));
manager.notifier = notifier;
manager.init();

// Daily email digest: checked every 5 minutes, sent once per day after the
// configured hour.
const DAY_MS = 24 * 3600 * 1000;
setInterval(() => notifier.maybeDigest(() => manager.digestData(Date.now() - DAY_MS)), 5 * 60 * 1000);
// Subscription renewals (M15): reminder the day before, date rolls forward
// once it has passed. Same cadence, plus once at boot.
setInterval(() => manager.checkRenewals(), 5 * 60 * 1000);
setTimeout(() => manager.checkRenewals(), 2000);

const wrap = (fn) => (req, res) => {
  try {
    Promise.resolve(fn(req, res)).catch((err) => sendErr(res, err));
  } catch (err) {
    sendErr(res, err);
  }
};

function sendErr(res, err) {
  res.status(err.status || 500).json({ error: err.message });
}

// Registered agents (Round 5): definitions the dashboard owns. Seeded from
// agents.config.js on first boot; edited and removed here from then on.
app.get('/api/agents', wrap((req, res) => res.json(manager.listAgents())));

app.get('/api/agent-types', wrap((req, res) => res.json(manager.agentTypes())));

app.post('/api/agents', wrap((req, res) => {
  res.json(manager.addAgent(req.body || {}));
}));

app.put('/api/agents/:id', wrap((req, res) => {
  res.json(manager.updateAgent(req.params.id, req.body || {}));
}));

app.delete('/api/agents/:id', wrap((req, res) => {
  manager.removeAgent(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/agents/:id/settings', wrap((req, res) => {
  res.json(manager.getAgentSettings(req.params.id));
}));

app.put('/api/agents/:id/settings', wrap((req, res) => {
  res.json(manager.updateAgentSettings(req.params.id, req.body || {}));
}));

// Launch: a new instance of this agent on a project, optionally with its
// first prompt already sent.
app.post('/api/agents/:id/instances', wrap((req, res) => {
  res.json(manager.launchInstance(req.params.id, req.body || {}));
}));

// Instances: live sessions of a registered agent on one project. Everything
// that used to hang off an agent (chat, queue, files, git, settings) hangs
// off an instance now.
app.get('/api/instances', wrap((req, res) => res.json(manager.listInstances())));

app.delete('/api/instances/:iid', wrap((req, res) => {
  manager.closeInstance(req.params.iid);
  res.json({ ok: true });
}));

app.delete('/api/instances/:iid/queue/:taskId', wrap((req, res) => {
  manager.cancelQueued(req.params.iid, req.params.taskId);
  res.json({ ok: true });
}));

app.post('/api/instances/:iid/queue/reorder', wrap((req, res) => {
  manager.reorderQueue(req.params.iid, (req.body || {}).order);
  res.json({ ok: true });
}));

// Filesystem browsing for the folder-picker dialog (directories only).
app.get('/api/fs/dirs', wrap((req, res) => {
  let p = String(req.query.path || '').trim() || os.homedir();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  p = path.resolve(p);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    p = os.homedir();
    stat = fs.statSync(p);
  }
  if (!stat.isDirectory()) p = path.dirname(p);
  let dirs = [];
  try {
    dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw Object.assign(new Error(`Cannot read ${p}: ${err.message}`), { status: 403 });
  }
  const parent = path.dirname(p);
  res.json({ path: p, parent: parent !== p ? parent : null, home: os.homedir(), dirs });
}));

app.post('/api/fs/mkdir', wrap((req, res) => {
  const base = String(req.body.path || '').trim();
  const name = String(req.body.name || '').trim();
  if (!base || !name) throw Object.assign(new Error('Missing path or name'), { status: 400 });
  if (name.includes('/') || name === '..' || name === '.') {
    throw Object.assign(new Error('Invalid folder name'), { status: 400 });
  }
  const target = path.join(path.resolve(base), name);
  fs.mkdirSync(target, { recursive: true });
  res.json({ path: target });
}));

// Chat attachments: saved into the instance's project so the CLI can read them.
app.post('/api/instances/:iid/attach', wrap((req, res) => {
  const entry = manager.get(req.params.iid);
  const { name, dataBase64 } = req.body || {};
  if (!name || !dataBase64) throw Object.assign(new Error('Missing name or data'), { status: 400 });
  if (dataBase64.length > 28 * 1024 * 1024) throw Object.assign(new Error('File too large (20MB max)'), { status: 400 });
  const safe = path.basename(String(name)).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
  const dir = path.join(manager.getWorkspaceDir(entry), '.attachments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, Date.now() + '-' + safe);
  fs.writeFileSync(file, Buffer.from(dataBase64, 'base64'));
  res.json({ path: file, name: safe });
}));

// Voice prompting (M16): Whisper settings (key + model) under `_voice` in
// settings.json, and the transcription endpoint itself. Audio arrives base64
// like chat attachments; browser dictation never touches the server.
app.get('/api/voice', wrap((req, res) => res.json(manager.voiceConfig())));

app.put('/api/voice', wrap((req, res) => {
  res.json(manager.updateVoice(req.body || {}));
}));

app.post('/api/transcribe', wrap(async (req, res) => {
  const { dataBase64, mime } = req.body || {};
  if (!dataBase64) throw Object.assign(new Error('Missing audio data'), { status: 400 });
  const buffer = Buffer.from(String(dataBase64), 'base64');
  if (!buffer.length) throw Object.assign(new Error('Audio data is empty'), { status: 400 });
  // 20MB decoded keeps the base64 payload under the 30mb express JSON limit.
  if (buffer.length > 20 * 1024 * 1024) throw Object.assign(new Error('Recording too large for Whisper (20MB max)'), { status: 400 });
  res.json(await voice.whisper(manager.voiceConfig(), buffer, String(mime || '')));
}));

app.get('/api/prompts', wrap((req, res) => res.json(manager.listPrompts())));

app.post('/api/prompts', wrap((req, res) => res.json(manager.addPrompt(req.body || {}))));

app.put('/api/prompts/:id', wrap((req, res) => res.json(manager.updatePrompt(req.params.id, req.body || {}))));

app.delete('/api/prompts/:id', wrap((req, res) => {
  manager.removePrompt(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/analytics', wrap(async (req, res) => res.json(await manager.analytics())));

// Fleet vault: where it lives and whether it's live. Configure via PUT
// { path, enabled } — stored under the reserved `_vault` key in settings.json.
app.get('/api/vault', wrap((req, res) => res.json(manager.vaultStatus())));

app.put('/api/vault', wrap(async (req, res) => {
  res.json(await manager.setVaultSettings(req.body || {}));
}));

// Vault browser (M14): the dashboard reads and edits the same vault the
// agents see through MCP; the write activity feed is the vault's git log.
app.get('/api/vault/notes', wrap((req, res) => res.json(manager.requireVault().index())));

app.get('/api/vault/note', wrap((req, res) => {
  res.json(manager.requireVault().read(String(req.query.path || '')));
}));

app.put('/api/vault/note', wrap(async (req, res) => {
  const { path, content, needsReview } = req.body || {};
  if (path === undefined || content === undefined) {
    throw Object.assign(new Error('Missing path or content'), { status: 400 });
  }
  const opts = { content: String(content) };
  if (needsReview !== undefined) opts.needsReview = !!needsReview;
  res.json(await manager.requireVault().write(String(path), opts));
}));

app.get('/api/vault/search', wrap((req, res) => {
  res.json(manager.requireVault().search({
    query: req.query.query,
    type: req.query.type,
    project: req.query.project,
    tag: req.query.tag,
    limit: req.query.limit,
  }));
}));

app.get('/api/vault/feed', wrap(async (req, res) => {
  res.json(await manager.requireVault().log(Math.min(+req.query.limit || 60, 200)));
}));

app.get('/api/vault/commit', wrap(async (req, res) => {
  res.json(await manager.requireVault().show(String(req.query.hash || '')));
}));

app.post('/api/vault/revert', wrap(async (req, res) => {
  res.json(await manager.requireVault().revert(String((req.body || {}).hash || '')));
}));

app.get('/api/feed', wrap((req, res) => {
  res.json(manager.feed(Math.min(+req.query.limit || 60, 200)));
}));

app.get('/api/notifications', wrap((req, res) => res.json(notifier.getConfig())));

app.put('/api/notifications', wrap((req, res) => {
  res.json(notifier.update(req.body || {}));
}));

app.post('/api/notifications/test', wrap(async (req, res) => {
  const channel = String((req.body || {}).channel || '');
  if (channel === 'telegram') {
    await notifier.telegramSend('🛰️ Mission Control test — Telegram alerts are working');
  } else if (channel === 'email') {
    await notifier.emailSend(
      'Mission Control test',
      '<p>🛰️ Email notifications are working.</p>',
      'Email notifications are working.'
    );
  } else {
    throw Object.assign(new Error('channel must be "telegram" or "email"'), { status: 400 });
  }
  res.json({ ok: true });
}));

app.post('/api/notifications/telegram/detect-chat', wrap(async (req, res) => {
  res.json(await notifier.detectChatId());
}));

app.post('/api/notifications/digest/send', wrap(async (req, res) => {
  await notifier.sendDigest(manager.digestData(Date.now() - DAY_MS));
  res.json({ ok: true });
}));

app.get('/api/tasks', wrap((req, res) => res.json(manager.listTasks())));

app.post('/api/tasks', wrap((req, res) => {
  res.json(manager.addTask(req.body || {}));
}));

app.put('/api/tasks/:id', wrap((req, res) => {
  res.json(manager.updateTask(req.params.id, req.body || {}));
}));

app.delete('/api/tasks/:id', wrap((req, res) => {
  manager.removeTask(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/tasks/:id/dispatch', wrap((req, res) => {
  res.json(manager.dispatchTask(req.params.id, String((req.body || {}).instanceId || '')));
}));

// Live CLI tabs: Claude Code sessions running anywhere on this machine —
// open interactive `claude` processes merged with fresh writes to the native
// session store. The dashboard's own managed agents are excluded — those
// already show as agent cards.
app.get('/api/cli-sessions', wrap(async (req, res) => {
  const sessions = await cliSessions.listLive({
    excludeIds: manager.managedSessionIds(),
    excludeCwdPrefix: path.join(__dirname, 'workspaces') + path.sep,
  });
  res.json({ sessions });
}));

// Native Claude Code session history for a registered project (sessions run
// from any terminal, not just through the dashboard).
app.get('/api/projects/:id/claude-sessions', wrap((req, res) => {
  const project = manager.findProject(req.params.id);
  if (!project) throw Object.assign(new Error('Unknown project'), { status: 404 });
  res.json(claudeStore.listSessions(project.path));
}));

app.get('/api/projects/:id/claude-sessions/:sid', wrap((req, res) => {
  const project = manager.findProject(req.params.id);
  if (!project) throw Object.assign(new Error('Unknown project'), { status: 404 });
  res.json(claudeStore.readSession(project.path, req.params.sid));
}));

// Project-owned history (Round 5): every conversation any instance ran
// against the project, and the raw events behind one of them.
app.get('/api/projects/:id/conversations', wrap((req, res) => {
  res.json(manager.conversations(req.params.id));
}));

app.get('/api/projects/:id/history', wrap((req, res) => {
  res.json(manager.projectHistory(req.params.id, { cid: req.query.cid ? String(req.query.cid) : null }));
}));

app.get('/api/projects', wrap((req, res) => res.json(manager.listProjects())));

app.post('/api/projects', wrap((req, res) => {
  res.json(manager.addProject(req.body || {}));
}));

app.put('/api/projects/:id', wrap((req, res) => {
  res.json(manager.updateProject(req.params.id, req.body || {}));
}));

app.delete('/api/projects/:id', wrap((req, res) => {
  manager.removeProject(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/instances/:iid/history', wrap((req, res) => {
  res.json(manager.instanceHistory(req.params.iid));
}));

app.get('/api/instances/:iid/skills', wrap((req, res) => {
  res.json(manager.listSkills(req.params.iid));
}));

app.post('/api/instances/:iid/chat', wrap((req, res) => {
  res.json(manager.sendChat(req.params.iid, String(req.body.message || '').trim()));
}));

app.post('/api/instances/:iid/stop', wrap((req, res) => {
  manager.stop(req.params.iid);
  res.json({ ok: true });
}));

app.post('/api/instances/:iid/session/clear', wrap((req, res) => {
  manager.clearSession(req.params.iid);
  res.json({ ok: true });
}));

app.post('/api/instances/:iid/history/clear', wrap((req, res) => {
  manager.clearHistory(req.params.iid);
  res.json({ ok: true });
}));

app.get('/api/instances/:iid/settings', wrap((req, res) => {
  res.json(manager.getSettings(req.params.iid));
}));

app.put('/api/instances/:iid/settings', wrap((req, res) => {
  res.json(manager.updateSettings(req.params.iid, req.body || {}));
}));

app.get('/api/instances/:iid/files', wrap((req, res) => {
  const entry = manager.get(req.params.iid);
  res.json(files.listDir(manager.getWorkspaceDir(entry), String(req.query.path || '')));
}));

app.get('/api/instances/:iid/file', wrap((req, res) => {
  const entry = manager.get(req.params.iid);
  res.json(files.readFileSafe(manager.getWorkspaceDir(entry), String(req.query.path || '')));
}));

app.put('/api/instances/:iid/file', wrap((req, res) => {
  const entry = manager.get(req.params.iid);
  const { path: rel, content } = req.body || {};
  if (!rel) throw Object.assign(new Error('Missing path'), { status: 400 });
  res.json(files.writeFileSafe(manager.getWorkspaceDir(entry), String(rel), String(content ?? '')));
}));

// Git operations run against the instance's project root.
const gitWrap = (fn) => wrap(async (req, res) => {
  const entry = manager.get(req.params.iid);
  const cwd = manager.getWorkspaceDir(entry);
  res.json(await fn(cwd, req));
});

app.get('/api/instances/:iid/git/status', gitWrap((cwd) => git.status(cwd)));
app.get('/api/instances/:iid/git/diff', gitWrap((cwd, req) => git.diff(cwd, req.query.path ? String(req.query.path) : null)));
app.get('/api/instances/:iid/git/log', gitWrap((cwd, req) => git.log(cwd, Math.min(+req.query.limit || 20, 100))));
app.get('/api/instances/:iid/git/show', gitWrap((cwd, req) => git.show(cwd, String(req.query.hash || ''))));
app.get('/api/instances/:iid/git/branches', gitWrap((cwd) => git.branches(cwd)));
app.post('/api/instances/:iid/git/commit', gitWrap((cwd, req) => git.commit(cwd, (req.body || {}).message)));
app.post('/api/instances/:iid/git/branch', gitWrap((cwd, req) => git.createBranch(cwd, String((req.body || {}).name || ''))));
app.post('/api/instances/:iid/git/checkout', gitWrap((cwd, req) => git.checkout(cwd, String((req.body || {}).name || ''))));
app.post('/api/instances/:iid/git/discard', gitWrap((cwd, req) => git.discard(cwd, String((req.body || {}).path || ''))));
app.post('/api/instances/:iid/git/init', gitWrap((cwd) => git.init(cwd)));

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({
    type: 'hello',
    agents: manager.listAgents(),
    instances: manager.listInstances(),
    projects: manager.listProjects(),
    tasks: manager.listTasks(),
  }));
});

server.listen(PORT, () => {
  console.log(`Mission Control online → http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  manager.shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  manager.shutdown();
  process.exit(0);
});
