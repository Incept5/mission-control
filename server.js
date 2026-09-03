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

const manager = new AgentManager(agentsConfig, broadcast, __dirname);
const notifier = new Notifier(path.join(__dirname, 'data'));
manager.notifier = notifier;
manager.init();

// Daily email digest: checked every 5 minutes, sent once per day after the
// configured hour.
const DAY_MS = 24 * 3600 * 1000;
setInterval(() => notifier.maybeDigest(() => manager.digestData(Date.now() - DAY_MS)), 5 * 60 * 1000);

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

app.get('/api/agents', wrap((req, res) => res.json(manager.list())));

app.get('/api/agent-types', wrap((req, res) => res.json(manager.agentTypes())));

app.post('/api/agents', wrap((req, res) => {
  res.json(manager.addAgent(req.body || {}));
}));

app.delete('/api/agents/:id', wrap((req, res) => {
  manager.removeAgent(req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/agents/:id/queue/:taskId', wrap((req, res) => {
  manager.cancelQueued(req.params.id, req.params.taskId);
  res.json({ ok: true });
}));

app.post('/api/agents/:id/queue/reorder', wrap((req, res) => {
  manager.reorderQueue(req.params.id, (req.body || {}).order);
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

// Chat attachments: saved into the agent's workspace so the CLI can read them.
app.post('/api/agents/:id/attach', wrap((req, res) => {
  const entry = manager.get(req.params.id);
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
  res.json(manager.dispatchTask(req.params.id, String((req.body || {}).agentId || '')));
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

app.post('/api/agents/:id/project', wrap((req, res) => {
  manager.setAgentProject(req.params.id, req.body.projectId || null);
  res.json({ ok: true });
}));

app.get('/api/agents/:id/history', wrap((req, res) => {
  res.json(manager.get(req.params.id).history);
}));

app.get('/api/agents/:id/skills', wrap((req, res) => {
  res.json(manager.listSkills(req.params.id));
}));

app.post('/api/agents/:id/chat', wrap((req, res) => {
  res.json(manager.sendChat(req.params.id, String(req.body.message || '').trim()));
}));

app.post('/api/agents/:id/stop', wrap((req, res) => {
  manager.stop(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/agents/:id/session/clear', wrap((req, res) => {
  manager.clearSession(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/agents/:id/history/clear', wrap((req, res) => {
  manager.clearHistory(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/agents/:id/settings', wrap((req, res) => {
  res.json(manager.getSettings(req.params.id));
}));

app.put('/api/agents/:id/settings', wrap((req, res) => {
  res.json(manager.updateSettings(req.params.id, req.body || {}));
}));

app.get('/api/agents/:id/files', wrap((req, res) => {
  const entry = manager.get(req.params.id);
  res.json(files.listDir(manager.getWorkspaceDir(entry), String(req.query.path || '')));
}));

app.get('/api/agents/:id/file', wrap((req, res) => {
  const entry = manager.get(req.params.id);
  res.json(files.readFileSafe(manager.getWorkspaceDir(entry), String(req.query.path || '')));
}));

app.put('/api/agents/:id/file', wrap((req, res) => {
  const entry = manager.get(req.params.id);
  const { path: rel, content } = req.body || {};
  if (!rel) throw Object.assign(new Error('Missing path'), { status: 400 });
  res.json(files.writeFileSafe(manager.getWorkspaceDir(entry), String(rel), String(content ?? '')));
}));

// Git operations run against the agent's current workspace (project root when
// one is selected).
const gitWrap = (fn) => wrap(async (req, res) => {
  const entry = manager.get(req.params.id);
  const cwd = manager.getWorkspaceDir(entry);
  res.json(await fn(cwd, req));
});

app.get('/api/agents/:id/git/status', gitWrap((cwd) => git.status(cwd)));
app.get('/api/agents/:id/git/diff', gitWrap((cwd, req) => git.diff(cwd, req.query.path ? String(req.query.path) : null)));
app.get('/api/agents/:id/git/log', gitWrap((cwd, req) => git.log(cwd, Math.min(+req.query.limit || 20, 100))));
app.get('/api/agents/:id/git/show', gitWrap((cwd, req) => git.show(cwd, String(req.query.hash || ''))));
app.get('/api/agents/:id/git/branches', gitWrap((cwd) => git.branches(cwd)));
app.post('/api/agents/:id/git/commit', gitWrap((cwd, req) => git.commit(cwd, (req.body || {}).message)));
app.post('/api/agents/:id/git/branch', gitWrap((cwd, req) => git.createBranch(cwd, String((req.body || {}).name || ''))));
app.post('/api/agents/:id/git/checkout', gitWrap((cwd, req) => git.checkout(cwd, String((req.body || {}).name || ''))));
app.post('/api/agents/:id/git/discard', gitWrap((cwd, req) => git.discard(cwd, String((req.body || {}).path || ''))));
app.post('/api/agents/:id/git/init', gitWrap((cwd) => git.init(cwd)));

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({
    type: 'hello',
    agents: manager.list(),
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
