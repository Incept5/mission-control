const fs = require('fs');
const os = require('os');
const path = require('path');

// Reads Claude Code's native local session store (~/.claude/projects/<encoded>/)
// so registered projects show their full history — including CLI sessions that
// never went through the dashboard.

const MAX_STRING = 4000;
const HEAD_BYTES = 192 * 1024;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function truncateDeep(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? value.slice(0, MAX_STRING) + `\n… [truncated ${value.length - MAX_STRING} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, depth + 1);
    return out;
  }
  return value;
}

function storeDirFor(projectPath) {
  let p = projectPath;
  try {
    p = fs.realpathSync(projectPath);
  } catch {}
  return path.join(os.homedir(), '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'));
}

function parseLines(text) {
  return text.split('\n').map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return parseLines(buf.toString('utf8', 0, n));
  } catch {
    return [];
  }
}

function firstUserText(rec) {
  const content = rec.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.find((b) => b.type === 'text')?.text || '';
  text = String(text).trim();
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return null;
  return text.slice(0, 120);
}

// Ancestor working directories to also search: a session opened in a repo's
// parent folder (or monorepo root) still belongs to the project's story.
function ancestorDirs(projectPath, maxLevels = 3) {
  let p = projectPath;
  try {
    p = fs.realpathSync(projectPath);
  } catch {}
  const home = os.homedir();
  const out = [];
  let cur = path.dirname(p);
  for (let i = 0; i < maxLevels; i++) {
    if (!cur.startsWith(home) || cur === home || cur === path.dirname(cur)) break;
    out.push(cur);
    cur = path.dirname(cur);
  }
  return out;
}

function headMeta(file) {
  const meta = { firstPrompt: null, summary: null, model: null, branch: null, startTs: null, cwd: null };
  for (const rec of readHead(file)) {
    if (rec.isSidechain) continue;
    if (!meta.cwd && rec.cwd) meta.cwd = rec.cwd;
    if (!meta.startTs && rec.timestamp) meta.startTs = Date.parse(rec.timestamp) || null;
    if (!meta.summary && rec.type === 'summary' && rec.summary) meta.summary = String(rec.summary).slice(0, 120);
    if (!meta.branch && rec.gitBranch) meta.branch = rec.gitBranch;
    if (!meta.firstPrompt && rec.type === 'user') meta.firstPrompt = firstUserText(rec);
    if (!meta.model && rec.type === 'assistant' && rec.message?.model) meta.model = rec.message.model;
    if (meta.firstPrompt && meta.summary && meta.model && meta.branch && meta.cwd) break;
  }
  return meta;
}

function listDirSessions(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const meta = headMeta(full);
    sessions.push({
      id: f.replace(/\.jsonl$/, ''),
      title: meta.summary || meta.firstPrompt || '(no prompt captured)',
      size: stat.size,
      mtime: stat.mtimeMs,
      startTs: meta.startTs,
      model: meta.model,
      branch: meta.branch,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// Live CLI tabs: sessions anywhere in the local store whose transcript file
// was written to within the last `windowMs`, regardless of which folder they
// run in or whether the project is registered. An idle-but-open tab stops
// writing, so mtime is a heartbeat, not a process check.
const LIVE_WINDOW_MS = 5 * 60 * 1000;

function listLiveSessions(windowMs = LIVE_WINDOW_MS) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = Date.now() - windowMs;
  const live = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      const meta = headMeta(full);
      live.push({
        id: f.replace(/\.jsonl$/, ''),
        title: meta.summary || meta.firstPrompt || '(no prompt captured)',
        cwd: meta.cwd,
        model: meta.model,
        branch: meta.branch,
        startTs: meta.startTs,
        mtime: stat.mtimeMs,
      });
    }
  }
  live.sort((a, b) => b.mtime - a.mtime);
  return live;
}

function listSessions(projectPath) {
  const dir = storeDirFor(projectPath);
  const sessions = listDirSessions(dir).slice(0, 80);
  const parentSessions = [];
  for (const ancestor of ancestorDirs(projectPath)) {
    for (const s of listDirSessions(storeDirFor(ancestor))) {
      parentSessions.push({ ...s, fromDir: ancestor });
    }
  }
  parentSessions.sort((a, b) => b.mtime - a.mtime);
  return { storeDir: dir, sessions, parentSessions: parentSessions.slice(0, 40) };
}

// Map native transcript records onto the dashboard's chat event shapes.
function readSession(projectPath, sessionId, cap = 500) {
  if (!/^[A-Za-z0-9-]{4,80}$/.test(sessionId)) throw httpError(400, 'Invalid session id');
  // Look in the project's own store first, then ancestor-folder stores.
  let text = null;
  for (const base of [projectPath, ...ancestorDirs(projectPath)]) {
    try {
      text = fs.readFileSync(path.join(storeDirFor(base), sessionId + '.jsonl'), 'utf8');
      break;
    } catch {}
  }
  if (text === null) throw httpError(404, 'Session not found in local Claude Code store');
  const events = [];
  for (const rec of parseLines(text)) {
    if (rec.isSidechain) continue;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) || undefined : undefined;
    if (rec.type === 'summary' && rec.summary) {
      events.push({ type: 'meta', text: 'Summary: ' + rec.summary, ts });
    } else if (rec.type === 'user') {
      const content = rec.message?.content;
      if (typeof content === 'string') {
        if (content.trim()) events.push({ type: 'user_prompt', text: truncateDeep(content), ts });
      } else if (Array.isArray(content)) {
        const toolResults = content.filter((b) => b.type === 'tool_result');
        if (toolResults.length) {
          events.push({ type: 'user', message: { content: truncateDeep(toolResults) }, ts });
        }
        const texts = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (texts) events.push({ type: 'user_prompt', text: truncateDeep(texts), ts });
      }
    } else if (rec.type === 'assistant' && rec.message?.content) {
      events.push({ type: 'assistant', message: { content: truncateDeep(rec.message.content) }, ts });
    }
  }
  return {
    events: events.slice(-cap),
    total: events.length,
    truncated: events.length > cap,
  };
}

module.exports = { storeDirFor, headMeta, listSessions, listLiveSessions, readSession };
