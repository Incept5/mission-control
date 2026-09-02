const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const claudeStore = require('./claude-store');

// Detects Claude Code CLI tabs running on this machine (any terminal, any
// folder, wrapper aliases included) by merging two signals:
//   - the process table: which interactive `claude` processes are open, and
//     in which working directory (an idle tab shows here but writes nothing)
//   - the native session store: which transcripts were written to recently
//     (tells us what each tab is doing, its model, branch, and first prompt)

const FRESH_MS = 2 * 60 * 1000;

function exec(cmd, args) {
  return new Promise((resolve) => {
    // lsof exits non-zero when some pids yield nothing — keep partial output.
    execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(stdout || '');
    });
  });
}

async function listProcesses() {
  const out = await exec('ps', ['-axo', 'pid=,command=']);
  const procs = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[2].split(/\s+/);
    const bin = (args[0] || '').split('/').pop();
    if (bin !== 'claude') continue;
    // Headless runs (`claude -p …`, e.g. the dashboard's own managed agents)
    // are not tabs.
    if (args[1] === '-p' || args.includes('--print') || args.includes('--output-format')) continue;
    const mi = args.indexOf('--model');
    procs.push({ pid: +m[1], modelArg: mi >= 0 ? args[mi + 1] || null : null });
  }
  if (!procs.length) return [];
  const lout = await exec('lsof', ['-a', '-p', procs.map((p) => p.pid).join(','), '-d', 'cwd', '-Fn']);
  const cwdByPid = {};
  let cur = null;
  for (const line of lout.split('\n')) {
    if (line.startsWith('p')) cur = +line.slice(1);
    else if (line.startsWith('n') && cur) cwdByPid[cur] = line.slice(1);
  }
  return procs.map((p) => ({ ...p, cwd: cwdByPid[p.pid] || null }));
}

// Most recent transcript in a folder's store dir — what an idle tab was last
// doing. Stats every file but head-parses only the newest.
function newestSession(cwd) {
  const dir = claudeStore.storeDirFor(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best = null;
  for (const f of files) {
    try {
      const stat = fs.statSync(path.join(dir, f));
      if (!best || stat.mtimeMs > best.mtime) best = { file: f, mtime: stat.mtimeMs };
    } catch {}
  }
  if (!best) return null;
  const meta = claudeStore.headMeta(path.join(dir, best.file));
  return {
    id: best.file.replace(/\.jsonl$/, ''),
    title: meta.summary || meta.firstPrompt || null,
    model: meta.model,
    branch: meta.branch,
    mtime: best.mtime,
  };
}

async function listLive({ excludeIds = new Set(), excludeCwdPrefix = null } = {}) {
  const excluded = (cwd) => excludeCwdPrefix && cwd && (cwd + path.sep).startsWith(excludeCwdPrefix);
  const procs = (await listProcesses().catch(() => [])).filter((p) => !excluded(p.cwd));
  const live = claudeStore.listLiveSessions().filter((s) => !excludeIds.has(s.id) && !excluded(s.cwd));

  // Claim a process for each fresh session, matched by working directory.
  // When two tabs share a folder, prefer the process whose --model argument
  // agrees with the transcript (wrapper aliases pass --model explicitly).
  const claimed = new Set();
  for (const s of live) {
    const cands = procs.filter((p) => p.cwd && p.cwd === s.cwd && !claimed.has(p.pid));
    const p =
      cands.find((c) => c.modelArg && s.model && s.model.toLowerCase().startsWith(c.modelArg.toLowerCase())) ||
      cands.find((c) => !c.modelArg) ||
      cands[0];
    if (p) {
      claimed.add(p.pid);
      s.pid = p.pid;
      if (!s.model) s.model = p.modelArg;
    }
    s.open = !!p;
  }

  // Tabs that are open but idle: no recent transcript writes. Show them with
  // the last thing they (or their folder) worked on.
  for (const p of procs) {
    if (claimed.has(p.pid)) continue;
    const last = p.cwd ? newestSession(p.cwd) : null;
    live.push({
      id: last ? last.id : 'pid-' + p.pid,
      title: last ? (last.title || '(no prompt captured)') : '(idle — no recent activity)',
      cwd: p.cwd,
      model: p.modelArg || last?.model || null,
      branch: last?.branch || null,
      startTs: null,
      mtime: last?.mtime || null,
      pid: p.pid,
      open: true,
    });
  }

  live.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return live;
}

module.exports = { listLive, FRESH_MS };
