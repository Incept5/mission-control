#!/usr/bin/env node

// Stateless stdio MCP server for the fleet vault (ROADMAP M12). Spawned once
// per agent run by the agent's own CLI (via --mcp-config or the adapter's
// equivalent), pointed at the vault and attributed to that agent+session
// through env — so every auto-commit names the writer, and nothing is shared
// between two concurrent runs except the vault itself.
//
//   VAULT_DIR           absolute path to the vault
//   VAULT_AUTHOR_NAME   git author name,  e.g. "agent/glm (s-1756…)"
//   VAULT_AUTHOR_EMAIL  git author email, e.g. "glm@mission-control"
//
// Speaks newline-delimited JSON-RPC 2.0 (MCP stdio transport). Every method
// is answered independently; no state is kept between messages.

'use strict';

const path = require('path');
const Vault = require('./vault');

// Refuse to guess: an unset VAULT_DIR would resolve to this process's cwd —
// the project dir — and the first write would bury a git repo in it.
const vault = process.env.VAULT_DIR
  ? new Vault(process.env.VAULT_DIR, {
      name: process.env.VAULT_AUTHOR_NAME || 'agent',
      email: process.env.VAULT_AUTHOR_EMAIL || 'agent@mission-control',
    })
  : null;

const TYPES = Vault.NOTE_TYPES;

const TOOLS = [
  {
    name: 'vault_search',
    description:
      'Search the shared fleet vault (all agents\' notes, the project catalog, and mission-control decisions). ' +
      'Full-text query plus optional filters; an empty query lists what matches the filters.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text to find in title, body, path, or tags' },
        type: { type: 'string', enum: TYPES, description: 'Filter by note type' },
        project: { type: 'string', description: 'Filter by project slug' },
        tag: { type: 'string', description: 'Filter by tag (exact, case-insensitive)' },
        limit: { type: 'number', description: 'Max results (default 20, cap 50)' },
      },
    },
  },
  {
    name: 'vault_read',
    description: 'Read one note from the vault, frontmatter included.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path, e.g. "notes/api-gotchas.md" (bare name = notes/)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'vault_write',
    description:
      'Create or overwrite a note. Frontmatter (author, updated) is stamped server-side and validated: ' +
      'notes need a type, and writing into _catalog/ or _mc/ is allowed but attributed and flagged.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path (bare name lands in notes/)' },
        content: { type: 'string', description: 'Note body in Markdown; any frontmatter you include is merged' },
        type: { type: 'string', enum: TYPES },
        project: { type: 'string', description: 'Project slug; omit for cross-project notes' },
        tags: { type: 'array', items: { type: 'string' } },
        needsReview: { type: 'boolean', description: 'Flag the note as stale/needs-review' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'vault_append',
    description:
      'Append a dated, attributed section to an existing note — the safe way to add to shared memory. ' +
      'Use vault_write first if the note does not exist yet.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the existing note' },
        text: { type: 'string', description: 'Markdown to append' },
        heading: { type: 'string', description: 'Optional short heading for the appended section' },
      },
      required: ['path', 'text'],
    },
  },
];

function fmtEntry(e) {
  const meta = [
    `path: ${e.path}`,
    `type: ${e.type || '—'}`,
    e.project ? `project: ${e.project}` : null,
    e.tags.length ? `tags: ${e.tags.join(', ')}` : null,
    e.author ? `author: ${e.author}` : null,
    e.updated ? `updated: ${e.updated}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `### ${e.title}\n${meta}${e.snippet ? `\n> …${e.snippet}…` : ''}`;
}

async function callTool(name, input) {
  if (!vault) {
    throw new Error('Vault is not configured (missing VAULT_DIR)');
  }
  switch (name) {
    case 'vault_search': {
      const hits = vault.search(input || {});
      return hits.length
        ? `${hits.length} note${hits.length === 1 ? '' : 's'}:\n\n${hits.map(fmtEntry).join('\n\n')}`
        : 'No matches. The vault may not cover this yet — if you learned something durable, write it (vault_write).';
    }
    case 'vault_read': {
      const note = vault.read(String((input || {}).path || ''));
      return `${note.path}\n\n${note.text}`;
    }
    case 'vault_write': {
      const opts = input || {};
      if (!String(opts.content || '').trim()) throw new Error('content is required');
      const r = await vault.write(opts.path, opts);
      return `${r.created ? 'Created' : 'Updated'} ${r.path}${r.commit ? ` (commit ${r.commit})` : ''}`;
    }
    case 'vault_append': {
      const opts = input || {};
      if (!String(opts.text || '').trim()) throw new Error('text is required');
      const r = await vault.append(opts.path, opts.text, opts.heading || null);
      return `Appended to ${r.path}${r.commit ? ` (commit ${r.commit})` : ''}`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// MCP version negotiation: speak the client's dialect when we recognize it,
// otherwise fall back to the version we were built against.
function negotiateProtocol(requested) {
  return typeof requested === 'string' && requested ? requested : '2025-06-18';
}

async function dispatch(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: negotiateProtocol(msg.params && msg.params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: 'mission-control-vault', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args } = msg.params || {};
      try {
        const text = await callTool(name, args || {});
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        // Tool failures are results, not protocol errors — the agent sees them.
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }
    default: {
      const err = new Error(`Method not found: ${msg.method}`);
      err.code = -32601;
      throw err;
    }
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Notifications (no id) get no response; unknown ones are ignored silently.
  if (msg.id === undefined || msg.id === null) return;
  try {
    const result = await dispatch(msg);
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: err.code || -32603, message: err.message },
    });
  }
}
