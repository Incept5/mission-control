const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Shared fleet vault (ROADMAP M12): a plain Markdown folder that is its own
// git repo, so every registered agent can query and write fleet memory through
// the MCP server (lib/vault-mcp.js) while Mission Control reads/writes it
// in-process. The vault lives OUTSIDE the MC repo (data/ is gitignored), path
// per machine in data/settings.json under the reserved `_vault` key.
//
// Layout:
//   notes/     agent-written notes (the point of the vault)
//   _catalog/  one auto-maintained page per registered project (MC-owned)
//   _mc/       Mission Control's own distilled decisions (MC-owned)
// Agents may write anywhere; writes into _catalog/ or _mc/ are flagged in the
// commit message but never blocked. Notes carry YAML frontmatter; this file
// parses/serializes the subset we emit (scalars + string lists), enough for
// Obsidian to adopt the folder as a vault later.

const NOTE_TYPES = ['project-note', 'convention', 'decision', 'gotcha', 'how-to'];
const RESERVED_DIRS = ['_catalog', '_mc'];
const NOTES_DIR = 'notes';
// Leading `_` is allowed (it names the reserved folders); a leading `.` is
// rejected separately so dotfiles like .obsidian stay unwritable.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9 ._-]{0,79}$/;
const HASH_RE = /^[0-9a-f]{4,40}$/i;
const SHOW_CAP = 300 * 1024;

// The spawn preamble is short on purpose — it rides along with every run.
const PREAMBLE_CAP = 6000;
const PAGE_CAP = 2000;
const INDEX_LINE_CAP = 220;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isoDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* ── Frontmatter subset ─────────────────────────────────────────── */

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

// Parses `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines.
// Unknown syntax is skipped rather than thrown — a note must never become
// unreadable because one line is exotic.
function parseFrontmatter(text) {
  const lines = String(text).split('\n');
  if (lines[0].trim() !== '---') return { fm: null, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { fm: null, body: text };
  const fm = {};
  let key = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^\s+-\s/.test(line) && key) {
      (fm[key] ||= []).push(unquote(line.replace(/^\s+-\s*/, '').trim()));
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    key = m[1];
    const v = m[2].trim();
    if (!v) {
      fm[key] = null; // may turn into a list on the following lines
    } else if (v.startsWith('[') && v.endsWith(']')) {
      fm[key] = v
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      fm[key] = unquote(v);
      // YAML scalars: a bare true/false is a boolean (a quoted one stays a
      // string via unquote). Without this, `needs-review: true` written by
      // write() would read back as "true" and index() would miss the flag.
      if (fm[key] === 'true') fm[key] = true;
      else if (fm[key] === 'false') fm[key] = false;
    }
  }
  return { fm, body: lines.slice(end + 1).join('\n') };
}

// A YAML-safe scalar: bare when it's plain path-ish text, double-quoted
// (JSON escaping is valid YAML) when it could change the meaning of the line.
function fmScalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s && /^[A-Za-z0-9/._~@ -]+$/.test(s) && !/^\s|\s$/.test(s) && !s.includes('  ')) return s;
  return JSON.stringify(s);
}

// One rule for what gets emitted: undefined/null/empty → dropped (null).
function fmValue(v) {
  if (v === undefined || v === null || v === '') return null;
  if (Array.isArray(v)) return v.length ? `[${v.map(fmScalar).join(', ')}]` : null;
  return fmScalar(v);
}

// Emits keys in `order` first (when present), then any extras alphabetically,
// dropping null/undefined/empty values so notes stay clean.
function serializeFrontmatter(fm, order = []) {
  const keys = [
    ...order.filter((k) => fmValue(fm[k]) !== null),
    ...Object.keys(fm).filter((k) => !order.includes(k)).sort(),
  ];
  const lines = keys
    .filter((k) => fmValue(fm[k]) !== null)
    .map((k) => `${k}: ${fmValue(fm[k])}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

function titleOf(body, relPath) {
  const m = String(body).match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return path.basename(relPath, '.md');
}

// Frontmatter equality ignoring the writer stamps (write() re-stamps
// author/updated on every write, so they never count as a change).
function fmEq(a, b) {
  const keys = (o) => Object.keys(o).filter((k) => k !== 'author' && k !== 'updated').sort();
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

// `vault: create notes/x.md [reserved folder] — writer` → { action, path,
// reserved }. Subjects this repo never generated (hand-made commits, a
// `Revert "…"` wrapper) parse as action 'other' so the feed still shows them.
// The ` — writer` suffix is dropped before parsing — the author is read from
// git itself (%an), and path segments can't contain an em dash (SEGMENT_RE).
function parseCommitSubject(subject) {
  let s = String(subject || '');
  if (s.startsWith('Revert "')) s = s.replace(/^Revert "/, '').replace(/"$/, '');
  if (!s.startsWith('vault: ')) return { action: 'other', path: null, reserved: false };
  let head = s.slice('vault: '.length);
  const cut = head.lastIndexOf(' — ');
  if (cut >= 0) head = head.slice(0, cut);
  const reserved = head.endsWith(' [reserved folder]');
  if (reserved) head = head.slice(0, -' [reserved folder]'.length);
  const m = head.match(/^(create|update|append|initialize)\b\s*(.*)$/);
  if (!m) return { action: 'other', path: null, reserved };
  return { action: m[1], path: m[2].trim() || null, reserved };
}

/* ── Vault ──────────────────────────────────────────────────────── */

class Vault {
  constructor(dir, author = null) {
    this.dir = path.resolve(String(dir || '.'));
    // Attribution for auto-commits: { name, email }. Agents get
    // "agent/<id> (<session>)" via the MCP server's env; in-process writes
    // default to mission-control.
    this.author = author || { name: 'mission-control', email: 'mission-control@localhost' };
    this.ready = false;
    this._ensuring = null;
  }

  // settings.json key `_vault` (reserved — agent ids can't start with `_`).
  // Default is a sibling of the MC repo so the vault is never inside it.
  static resolveDir(settingsAll, rootDir) {
    const raw = String((settingsAll && settingsAll._vault && settingsAll._vault.path) || '').trim();
    let p = raw || path.join(path.dirname(path.resolve(rootDir)), 'fleet-vault');
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    return path.resolve(p);
  }

  static get NOTE_TYPES() {
    return NOTE_TYPES;
  }

  git(args, opts = {}) {
    // Same ceiling guard as lib/git.js: the vault must be its own repo and
    // never read/write one further up the tree.
    let ceiling;
    try {
      ceiling = path.dirname(fs.realpathSync(this.dir));
    } catch {
      ceiling = path.dirname(this.dir);
    }
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: ceiling, ...(opts.env || {}) };
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.dir, env, timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !opts.allowFail) reject(fail(400, (stderr || err.message).trim().slice(0, 500)));
        else resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code ?? 1 : 0 });
      });
    });
  }

  // Cross-process mutex (manager + one MCP server per running agent) via a
  // lock dir under .git/, stolen when a crashed writer left it behind.
  async withLock(fn) {
    const lockDir = path.join(this.dir, '.git', 'vault.lock');
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch {
        let stale = false;
        try {
          stale = Date.now() - fs.statSync(lockDir).mtimeMs > 15000;
        } catch {}
        if (stale) {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch {}
          continue;
        }
        if (Date.now() > deadline) throw fail(503, 'Vault is busy — try again');
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // Idempotent, memoized initialization: dirs, git repo, identity, README,
  // initial commit. Safe for several processes to race into — after the first
  // init a sentinel short-circuits everything, so concurrent writers (each
  // with their own Vault instance) never fight over git's own lock files.
  ensure() {
    if (this.ready) return Promise.resolve();
    if (!this._ensuring) {
      this._ensuring = this._init().catch((err) => {
        this._ensuring = null; // a later call can retry a failed init
        throw err;
      });
    }
    return this._ensuring.then(() => {
      this.ready = true;
    });
  }

  async _init() {
    fs.mkdirSync(path.join(this.dir, NOTES_DIR), { recursive: true });
    for (const d of RESERVED_DIRS) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      await this.git(['init'], { allowFail: true }); // lost race → .git exists anyway
    }

    const sentinel = path.join(this.dir, '.git', 'mc-vault-initialized');
    if (!fs.existsSync(sentinel)) {
      const readme = path.join(this.dir, 'README.md');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(
          readme,
          [
            '# Fleet vault',
            '',
            'Shared memory for the AI agents managed by Mission Control. Every',
            'write is auto-committed to this repo, attributed to its writer.',
            '',
            `- \`${NOTES_DIR}/\` — agent-written notes (decisions, conventions, gotchas, how-tos)`,
            '- `_catalog/` — one auto-maintained page per registered project',
            '- `_mc/` — Mission Control’s own distilled decisions',
            '',
            'Notes carry frontmatter: type, project, tags, author, updated.',
            '',
          ].join('\n')
        );
      }
      // Committer identity is fixed; the writer rides on --author. Concurrent
      // first-inits both write the same values, so a loser's failure is fine.
      await this.git(['config', 'user.name', 'Mission Control Vault'], { allowFail: true });
      await this.git(['config', 'user.email', 'vault@mission-control'], { allowFail: true });
      await this.commitIfDirty('vault: initialize', this.author);
      fs.writeFileSync(sentinel, String(Date.now()));
    }
  }

  // Stage everything and commit when there is anything to commit. Returns the
  // short hash, or null when the tree was already clean.
  async commitIfDirty(message, author) {
    await this.git(['add', '-A']);
    const st = await this.git(['status', '--porcelain'], { allowFail: true });
    if (!st.stdout.trim()) return null;
    const c = await this.git(
      ['commit', '-m', message, '--author', `${author.name} <${author.email}>`],
      { allowFail: true }
    );
    if (c.code !== 0) throw fail(500, `git commit failed: ${(c.stderr || '').trim().slice(0, 300)}`);
    const r = await this.git(['rev-parse', '--short', 'HEAD']);
    return r.stdout.trim();
  }

  /* ── Paths ─────────────────────────────────────────────────────── */

  // Vault-relative note path: every segment must be a plain filename (no
  // dotfiles, no .., no escape), `.md` implied. Bare names are agent
  // shorthand for notes/ — unless a root-level file of that name exists
  // (e.g. README.md), in which case the real path wins.
  normalizeRelPath(raw) {
    let p = String(raw || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!p) throw fail(400, 'Note path is required');
    const parts = p.split('/').filter((s) => s && s !== '.');
    if (!parts.length || parts.some((s) => !SEGMENT_RE.test(s) || s.startsWith('.'))) {
      throw fail(400, 'Invalid note path');
    }
    p = parts.join('/');
    if (!p.endsWith('.md')) p += '.md';
    if (!p.includes('/') && !fs.existsSync(this.absOf(p))) p = `${NOTES_DIR}/${p}`;
    const abs = path.resolve(this.dir, p);
    if (!abs.startsWith(this.dir + path.sep)) throw fail(400, 'Path escapes the vault');
    return p;
  }

  absOf(rel) {
    return path.join(this.dir, rel);
  }

  isReserved(rel) {
    return RESERVED_DIRS.includes(rel.split('/')[0]);
  }

  /* ── Read ──────────────────────────────────────────────────────── */

  read(rawPath) {
    const rel = this.normalizeRelPath(rawPath);
    const abs = this.absOf(rel);
    if (!fs.existsSync(abs)) throw fail(404, `Note not found: ${rel}`);
    const text = fs.readFileSync(abs, 'utf8');
    const { fm, body } = parseFrontmatter(text);
    return { path: rel, title: titleOf(body, rel), fm: fm || {}, body, text };
  }

  // Index over every .md in the vault (git/config dirs skipped). Rebuilt on
  // demand — the vault is small and other processes may have written to it.
  index() {
    const out = [];
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (e.name.endsWith('.md')) {
          const rel = path.relative(this.dir, p);
          const { fm, body } = parseFrontmatter(fs.readFileSync(p, 'utf8'));
          out.push({
            path: rel,
            title: titleOf(body, rel),
            type: fm?.type || null,
            project: fm?.project || null,
            tags: Array.isArray(fm?.tags) ? fm.tags : [],
            needsReview: fm?.['needs-review'] === true,
            updated: fm?.updated || null,
            author: fm?.author || null,
          });
        }
      }
    };
    walk(this.dir);
    return out;
  }

  search({ query, type, project, tag, limit } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const lim = Math.min(Math.max(+limit || 20, 1), 50);
    let hits = this.index().filter(
      (e) =>
        (!type || e.type === type) &&
        (!project || e.project === project) &&
        (!tag || e.tags.some((t) => t.toLowerCase() === String(tag).toLowerCase()))
    );
    if (q) {
      hits = hits.filter((e) => {
        const note = this.read(e.path);
        return `${e.title}\n${e.path}\n${e.tags.join(' ')}\n${note.body}`.toLowerCase().includes(q);
      });
    }
    hits.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.path.localeCompare(b.path));
    return hits.slice(0, lim).map((e) => {
      let snippet = '';
      if (q) {
        const { body } = this.read(e.path);
        const idx = body.toLowerCase().indexOf(q);
        if (idx >= 0) {
          snippet = body
            .slice(Math.max(0, idx - 80), idx + 120)
            .replace(/\s+/g, ' ')
            .trim();
        }
      }
      return { ...e, snippet };
    });
  }

  /* ── Write ─────────────────────────────────────────────────────── */

  // Creates or overwrites a note. Frontmatter is composed server-side from
  // `opts` merged onto whatever frontmatter the content itself carried (so an
  // edit of a catalog page keeps its own fields), then validated: notes/
  // requires a known `type`. author/updated are always stamped to the writer.
  // Returns { path, created, commit }.
  async write(rawPath, opts = {}) {
    await this.ensure();
    return this.withLock(async () => {
      const rel = this.normalizeRelPath(rawPath);
      const { fm, body } = parseFrontmatter(String(opts.content || ''));
      const merged = { ...(fm || {}) };
      if (opts.type !== undefined) merged.type = opts.type;
      if (opts.project !== undefined) merged.project = opts.project || null;
      if (opts.tags !== undefined) {
        // Arrays are the contract, but an agent may send one comma-separated
        // string — accept it rather than dropping the tags silently.
        merged.tags = Array.isArray(opts.tags)
          ? opts.tags.map(String)
          : String(opts.tags).split(',').map((t) => t.trim()).filter(Boolean);
        if (!merged.tags.length) merged.tags = null;
      }
      if (opts.needsReview !== undefined) merged['needs-review'] = opts.needsReview ? true : null;

      if (merged.type === undefined || merged.type === null) {
        if (rel.startsWith(`${NOTES_DIR}/`)) {
          throw fail(400, `Notes need a type: ${NOTE_TYPES.join(' | ')}`);
        }
      } else if (typeof merged.type !== 'string') {
        throw fail(400, 'type must be a string');
      } else if (rel.startsWith(`${NOTES_DIR}/`) && !NOTE_TYPES.includes(merged.type)) {
        throw fail(400, `Unknown type "${merged.type}" — use one of ${NOTE_TYPES.join(' | ')}`);
      }
      if (merged.project && !/^[a-z0-9][a-z0-9-]*$/.test(String(merged.project))) {
        throw fail(400, 'project must be a slug (lowercase letters, digits, hyphens)');
      }
      if (merged.tags && (merged.tags.some((t) => !String(t).trim()) || new Set(merged.tags).size !== merged.tags.length)) {
        merged.tags = [...new Set(merged.tags.map((t) => String(t).trim()).filter(Boolean))];
      }

      merged.author = this.author.name;
      merged.updated = today();

      const abs = this.absOf(rel);
      const created = !fs.existsSync(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.tmp-' + Math.random().toString(36).slice(2, 8);
      fs.writeFileSync(tmp, serializeFrontmatter(merged, ['type', 'project', 'tags', 'needs-review', 'author', 'updated']) + body.trim() + '\n');
      fs.renameSync(tmp, abs);

      const commit = await this.commitIfDirty(
        `vault: ${created ? 'create' : 'update'} ${rel}${this.isReserved(rel) ? ' [reserved folder]' : ''} — ${this.author.name}`,
        this.author
      );
      return { path: rel, created, commit };
    });
  }

  // Adds a dated, attributed section to an existing note without rewriting the
  // rest of it — the concurrent-safe way for an agent to grow shared memory.
  // Returns { path, commit }.
  async append(rawPath, text, heading = null) {
    await this.ensure();
    return this.withLock(async () => {
      const note = this.read(rawPath); // 404s when the note doesn't exist yet
      const addition = String(text || '').trim();
      if (!addition) throw fail(400, 'Nothing to append');
      const stamp = `### ${today()} — ${this.author.name}${heading ? ` — ${heading}` : ''}`;
      const fm = {
        ...note.fm,
        updated: today(),
        author: this.author.name,
      };
      const body = note.body.replace(/\s*$/, '') + `\n\n${stamp}\n\n${addition}\n`;
      const abs = this.absOf(note.path);
      const tmp = abs + '.tmp-' + Math.random().toString(36).slice(2, 8);
      fs.writeFileSync(
        tmp,
        serializeFrontmatter(fm, ['type', 'project', 'tags', 'needs-review', 'author', 'updated']) + body
      );
      fs.renameSync(tmp, abs);
      const commit = await this.commitIfDirty(`vault: append ${note.path} — ${this.author.name}`, this.author);
      return { path: note.path, commit };
    });
  }

  /* ── History — the write activity feed (M14) ────────────────────── */

  // Every write is exactly one auto-commit, so the audit feed of who wrote
  // what, when, is the vault's own git log. Structured fields come from the
  // commit subject; the author and timestamp come from git.
  async log(limit = 60) {
    const lim = Math.min(Math.max(+limit || 60, 1), 200);
    const r = await this.git(
      ['log', '-n', String(lim), '--pretty=format:%h%x1f%an%x1f%ae%x1f%aI%x1f%s'],
      { allowFail: true } // no commits yet → an empty feed, not an error
    );
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, author, email, iso, subject] = line.split('\x1f');
        const revert = /^Revert "/.test(subject);
        const info = parseCommitSubject(subject);
        return {
          hash,
          author,
          email,
          ts: iso ? Date.parse(iso) : null,
          subject,
          action: info.action,
          path: info.path,
          reserved: info.reserved,
          revert,
        };
      });
  }

  // The patch behind one feed row.
  async show(hash) {
    if (!HASH_RE.test(String(hash || ''))) throw fail(400, 'Invalid commit hash');
    const r = await this.git(['show', hash, '--stat', '--patch', '--pretty=medium'], { allowFail: true });
    if (r.code !== 0) throw fail(404, `Commit not found: ${hash}`);
    return { text: r.stdout.slice(0, SHOW_CAP), truncated: r.stdout.length > SHOW_CAP };
  }

  // One-click revert of a single write (M14): reverting the write's commit
  // undoes exactly that write. The revert is itself a new commit (history
  // keeps both) attributed to this Vault's author — mission-control, since
  // only the dashboard calls this. A conflicting revert (later writes hit the
  // same lines) is aborted cleanly and reported as a 409.
  async revert(hash) {
    await this.ensure();
    if (!HASH_RE.test(String(hash || ''))) throw fail(400, 'Invalid commit hash');
    return this.withLock(async () => {
      // git revert has no --author flag; authorship rides on the environment.
      const r = await this.git(['revert', '--no-edit', hash], {
        allowFail: true,
        env: { GIT_AUTHOR_NAME: this.author.name, GIT_AUTHOR_EMAIL: this.author.email },
      });
      if (r.code !== 0) {
        await this.git(['revert', '--abort'], { allowFail: true });
        const why =
          (r.stderr || r.stdout || '')
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean) || 'revert failed';
        throw fail(409, `Cannot revert ${hash}: ${why.slice(0, 200)}`);
      }
      const out = await this.git(['rev-parse', '--short', 'HEAD']);
      return { commit: out.stdout.trim() };
    });
  }

  /* ── Catalog ───────────────────────────────────────────────────── */

  // Frontmatter keys MC owns on a catalog page. Anything else a page carries
  // (stack, needs-review, fields an agent added) survives a refresh.
  static get CATALOG_KEYS() {
    return ['type', 'project', 'path', 'summary', 'status', 'agents', 'registered', 'last-activity'];
  }

  // Regenerate `_catalog/<slug>.md` from live manager data (M13): written on
  // registration, refreshed on name/path/agent changes, stamped with the
  // day's activity by every finished run, flipped to retired on unregister.
  // The page is MC-owned but refreshes are surgical — foreign frontmatter
  // keys survive, and so does everything the dated-append convention added
  // to the body (vault_append sections); only the block above them is
  // rewritten. A refresh that changes nothing skips the write entirely, so
  // callers can fire on every run result without spamming commits.
  async refreshCatalog(info) {
    await this.ensure();
    const rel = `_catalog/${info.id}.md`;
    let existing = null;
    try {
      existing = this.read(rel);
    } catch {}
    const lastActivity = info.lastActivity || existing?.fm['last-activity'] || null;
    const fm = {
      type: 'catalog',
      project: info.id,
      path: info.path || null,
      summary: info.summary || info.name,
      status: info.status || 'active',
      agents: info.agents?.length ? info.agents : null,
      registered: info.registered || existing?.fm.registered || null,
      'last-activity': lastActivity,
    };
    if (existing) {
      for (const [k, v] of Object.entries(existing.fm)) {
        if (!Vault.CATALOG_KEYS.includes(k) && k !== 'author' && k !== 'updated') fm[k] = v;
      }
    }
    // Drop empty values the same way serialization will, so the change check
    // compares like for like (a `null` agents list must equal an absent key).
    for (const k of Object.keys(fm)) {
      if (fmValue(fm[k]) === null) delete fm[k];
    }
    const body = this.catalogBody(info, lastActivity, existing);
    if (existing && fmEq(existing.fm, fm) && existing.body.trim() === body.trim()) {
      return { changed: false, created: false, path: rel };
    }
    await this.write(rel, { content: serializeFrontmatter(fm, Vault.CATALOG_KEYS) + body });
    return { changed: true, created: !existing, path: rel };
  }

  // Retirement (M13): unregistering marks the page `status: retired`; the
  // page and every note about the project stay. Identity fields the manager
  // can no longer supply (the project is gone) are recovered from the page.
  async retireCatalog(slug, project = null) {
    await this.ensure();
    const rel = `_catalog/${slug}.md`;
    let existing = null;
    try {
      existing = this.read(rel);
    } catch {}
    if (existing && existing.fm.status === 'retired') return { changed: false, created: false, path: rel };
    const fm = existing?.fm || {};
    return this.refreshCatalog({
      id: slug,
      name: project?.name || (existing ? titleOf(existing.body, rel) : slug),
      path: project?.path || fm.path || null,
      summary: project?.description || fm.summary || null,
      registered: project?.createdAt ? isoDay(project.createdAt) : fm.registered || null,
      lastActivity: fm['last-activity'] || null,
      agents: [],
      status: 'retired',
    });
  }

  // The MC-owned block of a catalog page. Everything from the first dated
  // append stamp (`### YYYY-MM-DD — author`, vault_append's format) onward
  // is agent-written and carried over verbatim beneath it.
  catalogBody(info, lastActivity, existing) {
    const lines = [
      `# ${info.name}`,
      '',
      String(info.summary || info.name),
      '',
      ...(info.path ? [`- Path: \`${info.path}\``] : []),
      ...(info.agents?.length ? [`- Agents: ${info.agents.join(', ')}`] : []),
      ...(info.registered ? [`- Registered: ${info.registered}`] : []),
      ...(lastActivity ? [`- Last activity: ${lastActivity}`] : []),
      `- Status: ${info.status || 'active'}`,
    ];
    let body = lines.join('\n') + '\n';
    if (existing) {
      const m = existing.body.match(/^### \d{4}-\d{2}-\d{2} — .+$/m);
      if (m) body += '\n' + existing.body.slice(m.index).trim() + '\n';
    }
    return body;
  }

  /* ── `_mc/` distilled decisions ────────────────────────────────── */

  // Mission Control's own distilled decisions (M13): one note per planning
  // round, prepared by lib/mc-notes.js with a hash of its source. An
  // unchanged hash leaves the note alone — hand edits survive until the
  // source (ROADMAP.md) actually changes.
  async syncMcNotes(items) {
    await this.ensure();
    for (const item of items) {
      try {
        let current = null;
        try {
          current = this.read(item.rel);
        } catch {}
        if (current && current.fm['source-hash'] === item.hash) continue;
        await this.write(item.rel, { content: item.content });
      } catch (err) {
        console.warn(`vault: ${item.rel}: ${err.message}`);
      }
    }
  }

  // Catalog rows for the spawn preamble: one line per project. Unreadable
  // pages are skipped — a bad catalog file must not break every spawn.
  catalogIndex() {
    return this.index()
      .filter((e) => e.path.startsWith('_catalog/'))
      .map((e) => {
        try {
          return this.read(e.path);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((n) => ({
        project: n.fm.project || n.title,
        path: n.fm.path || null,
        summary: n.fm.summary || null,
        stack: Array.isArray(n.fm.stack) ? n.fm.stack : [],
        status: n.fm.status || 'active',
        body: n.body,
      }))
      .sort((a, b) => String(a.project).localeCompare(String(b.project)));
  }

  /* ── Spawn preamble ────────────────────────────────────────────── */

  // Capped context granted to every run: the fleet's project catalog, the
  // current project's own page, and the three vault rules. Rebuilt on every
  // call so a write earlier in this boot is already reflected.
  preambleFor(projectSlug) {
    const lines = [];
    lines.push('## Fleet context — shared vault');
    lines.push(`Vault: ${this.dir} — shared memory for every agent on this machine (git-tracked; your writes are committed under your name).`);
    lines.push('');
    lines.push('Projects:');
    const catalog = this.catalogIndex();
    if (catalog.length) {
      for (const c of catalog) {
        const one = [
          `- ${c.project}`,
          c.path,
          c.stack.join(', ') || null,
          c.status,
          c.summary,
        ]
          .filter((s) => s !== null && s !== '')
          .join(' — ');
        lines.push(one.length > INDEX_LINE_CAP ? one.slice(0, INDEX_LINE_CAP) + '…' : one);
      }
    } else {
      lines.push('- (catalog is empty)');
    }
    if (projectSlug) {
      const page = catalog.find((c) => c.project === projectSlug);
      lines.push('');
      lines.push(`Your project: ${projectSlug}`);
      let body = '(no catalog page yet)';
      if (page) {
        body = page.body.trim() || body;
        if (body.length > PAGE_CAP) body = body.slice(0, PAGE_CAP) + '…';
      }
      lines.push(body);
    }
    lines.push('');
    lines.push('Vault tools (MCP server "vault"): vault_search, vault_read, vault_write, vault_append.');
    lines.push('- Search before assuming — vault_search before deciding something is unknown.');
    lines.push('- Write durable learnings (decision / convention / gotcha / how-to) as notes.');
    lines.push('- Append to an existing note (vault_append) rather than duplicating it.');
    const text = lines.join('\n');
    return text.length > PREAMBLE_CAP ? text.slice(0, PREAMBLE_CAP) + '\n…' : text;
  }

  /* ── MCP plumbing ──────────────────────────────────────────────── */

  // The stdio MCP server this agent's CLI will spawn. Author travels in env —
  // the server process commits as this agent+session, not as MC.
  mcpDescriptor({ authorName, authorEmail }) {
    return {
      command: process.execPath,
      args: [path.join(__dirname, 'vault-mcp.js')],
      env: {
        VAULT_DIR: this.dir,
        VAULT_AUTHOR_NAME: authorName,
        VAULT_AUTHOR_EMAIL: authorEmail,
      },
    };
  }

  // { mcpServers } JSON for the CLIs that take an MCP config file
  // (Gemini; Claude Code can take the same object inline).
  mcpConfigJson(mcp) {
    return { mcpServers: { vault: mcp } };
  }

  writeMcpConfig(dataDir, agentId, mcp) {
    const dir = path.join(dataDir, 'vault-mcp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${agentId}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(this.mcpConfigJson(mcp), null, 2));
    // Runs are short-lived; drop configs from runs that ended long ago.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        try {
          if (e.isFile() && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
        } catch {}
      }
    } catch {}
    return file;
  }

  stats() {
    const idx = this.index();
    return {
      notes: idx.filter((e) => e.path.startsWith(`${NOTES_DIR}/`)).length,
      catalog: idx.filter((e) => e.path.startsWith('_catalog/')).length,
      mc: idx.filter((e) => e.path.startsWith('_mc/')).length,
    };
  }
}

module.exports = Vault;
