const fs = require('fs');
const path = require('path');

// Discovers the slash commands a Claude Code harness would offer in a given
// directory: `.claude/skills/<name>/SKILL.md` and `.claude/commands/<name>.md`
// (one level of sub-folders, as the CLI allows). Read-only — Mission Control
// never writes into a project's harness files.

const MAX_DESC = 160;

// Minimal YAML frontmatter reader: `key: value` pairs, with `>`/`|` block
// scalars folded into one line. Enough for name/description.
function frontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const lines = text.slice(3, end).split('\n');
  const out = {};
  let key = null;
  let block = false;
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      key = m[1];
      let value = m[2].trim();
      block = value === '>' || value === '|' || value === '>-' || value === '|-';
      if (block) value = '';
      out[key] = value.replace(/^(["'])(.*)\1$/, '$2');
    } else if (key && block && line.trim()) {
      out[key] = (out[key] ? out[key] + ' ' : '') + line.trim();
    }
  }
  return out;
}

function readFrontmatter(file) {
  try {
    return frontmatter(fs.readFileSync(file, 'utf8').slice(0, 8000));
  } catch {
    return {};
  }
}

function clip(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_DESC ? s.slice(0, MAX_DESC - 1) + '…' : s;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Returns [{ name, description, source }] for everything under <dir>/.claude.
function discover(dir, source) {
  if (!dir) return [];
  const out = [];
  const base = path.join(dir, '.claude');

  for (const ent of listDir(path.join(base, 'skills'))) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const file = path.join(base, 'skills', ent.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const fm = readFrontmatter(file);
    out.push({ name: ent.name, description: clip(fm.description), source });
  }

  const commands = path.join(base, 'commands');
  const walk = (folder, depth) => {
    for (const ent of listDir(folder)) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(folder, ent.name);
      if (ent.isDirectory()) {
        if (depth < 1) walk(full, depth + 1);
        continue;
      }
      if (!ent.name.endsWith('.md')) continue;
      const fm = readFrontmatter(full);
      out.push({ name: ent.name.slice(0, -3), description: clip(fm.description), source });
    }
  };
  walk(commands, 0);

  return out;
}

// Merges lists in priority order: the first entry for a name wins (so a
// project skill's description beats the bare name the CLI reported).
function merge(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const item of list) {
      if (!item || !item.name || seen.has(item.name)) continue;
      seen.set(item.name, item);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { discover, merge, frontmatter };
