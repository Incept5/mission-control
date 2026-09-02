const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_DIFF = 300 * 1024;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const HASH_RE = /^[0-9a-f]{4,40}$/i;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function git(cwd, args, opts = {}) {
  // Never let git discover a repository in an ancestor directory — a workspace
  // that isn't itself (inside) a repo must not read or write an outer repo.
  let ceiling;
  try {
    ceiling = path.dirname(fs.realpathSync(cwd));
  } catch {
    ceiling = path.dirname(path.resolve(cwd));
  }
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: ceiling };
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !opts.allowFail) {
        reject(httpError(400, (stderr || err.message).trim().slice(0, 500)));
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code ?? 1) : 0 });
      }
    });
  });
}

function unquote(p) {
  return p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p;
}

function contained(cwd, rel) {
  const abs = path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw httpError(400, 'Path escapes workspace');
  return abs;
}

async function isRepo(cwd) {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function hasHead(cwd) {
  return (await git(cwd, ['rev-parse', 'HEAD'], { allowFail: true })).code === 0;
}

async function untrackedFiles(cwd) {
  const r = await git(cwd, ['ls-files', '--others', '--exclude-standard'], { allowFail: true });
  return r.stdout.split('\n').filter(Boolean).map(unquote);
}

async function status(cwd) {
  if (!(await isRepo(cwd))) return { isRepo: false };
  const st = await git(cwd, ['status', '--porcelain=v1', '--branch']);
  let branch = null;
  let ahead = 0;
  let behind = 0;
  const changes = [];
  for (const line of st.stdout.split('\n').filter(Boolean)) {
    if (line.startsWith('##')) {
      const m = line.match(/^## (?:No commits yet on )?([^. ]+)/);
      branch = m ? m[1] : line.slice(3).trim();
      const a = line.match(/ahead (\d+)/);
      if (a) ahead = +a[1];
      const b = line.match(/behind (\d+)/);
      if (b) behind = +b[1];
    } else {
      const xy = line.slice(0, 2);
      let p = line.slice(3);
      if (p.includes(' -> ')) p = p.split(' -> ')[1];
      changes.push({
        status: xy === '??' ? 'U' : (xy.trim()[0] || 'M'),
        path: unquote(p),
        untracked: xy === '??',
      });
    }
  }
  let lastCommit = null;
  const lg = await git(cwd, ['log', '-1', '--pretty=format:%h\x1f%s\x1f%an\x1f%ar'], { allowFail: true });
  if (lg.code === 0 && lg.stdout) {
    const [hash, subject, author, when] = lg.stdout.split('\x1f');
    lastCommit = { hash, subject, author, when };
  }
  return { isRepo: true, branch, ahead, behind, changes, lastCommit };
}

// Unified diff of all uncommitted work (staged + unstaged + untracked),
// optionally narrowed to one path.
async function diff(cwd, relPath) {
  if (relPath) contained(cwd, relPath);
  let out = '';
  if (await hasHead(cwd)) {
    const args = ['diff', 'HEAD'];
    if (relPath) args.push('--', relPath);
    out += (await git(cwd, args, { allowFail: true })).stdout;
  } else {
    for (const base of [['diff', '--cached'], ['diff']]) {
      const args = relPath ? [...base, '--', relPath] : base;
      out += (await git(cwd, args, { allowFail: true })).stdout;
    }
  }
  for (const p of await untrackedFiles(cwd)) {
    if (relPath && p !== relPath) continue;
    if (out.length > MAX_DIFF) break;
    out += (await git(cwd, ['diff', '--no-index', '--', '/dev/null', p], { allowFail: true })).stdout;
  }
  return { diff: out.slice(0, MAX_DIFF), truncated: out.length > MAX_DIFF };
}

async function log(cwd, limit) {
  if (!(await hasHead(cwd))) return [];
  const r = await git(cwd, ['log', '-n', String(limit), '--pretty=format:%h\x1f%s\x1f%an\x1f%ar'], { allowFail: true });
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, subject, author, when] = line.split('\x1f');
    return { hash, subject, author, when };
  });
}

async function show(cwd, hash) {
  if (!HASH_RE.test(hash)) throw httpError(400, 'Invalid commit hash');
  const r = await git(cwd, ['show', hash, '--stat', '--patch', '--pretty=medium']);
  return { text: r.stdout.slice(0, MAX_DIFF), truncated: r.stdout.length > MAX_DIFF };
}

async function commit(cwd, message) {
  message = String(message || '').trim();
  if (!message) throw httpError(400, 'Commit message is required');
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  const r = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return { hash: r.stdout.trim() };
}

async function branches(cwd) {
  const r = await git(cwd, ['branch', '--format=%(refname:short)'], { allowFail: true });
  const cur = await git(cwd, ['branch', '--show-current'], { allowFail: true });
  return {
    branches: r.stdout.split('\n').filter(Boolean),
    current: cur.stdout.trim() || null,
  };
}

async function checkout(cwd, name) {
  if (!BRANCH_RE.test(name)) throw httpError(400, 'Invalid branch name');
  await git(cwd, ['checkout', name]);
  return { ok: true };
}

async function createBranch(cwd, name) {
  if (!BRANCH_RE.test(name)) throw httpError(400, 'Invalid branch name');
  await git(cwd, ['checkout', '-b', name]);
  return { ok: true };
}

// Discard uncommitted changes to one file: restore tracked files from HEAD,
// delete untracked ones.
async function discard(cwd, relPath) {
  if (!relPath) throw httpError(400, 'Missing path');
  const abs = contained(cwd, relPath);
  const tracked = (await git(cwd, ['ls-files', '--error-unmatch', '--', relPath], { allowFail: true })).code === 0;
  if (tracked) {
    await git(cwd, ['checkout', 'HEAD', '--', relPath]);
  } else {
    fs.rmSync(abs, { force: true });
  }
  return { ok: true };
}

async function init(cwd) {
  await git(cwd, ['init']);
  return { ok: true };
}

module.exports = { status, diff, log, show, commit, branches, checkout, createBranch, discard, init };
