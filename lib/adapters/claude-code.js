const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BaseAdapter = require('./base');
const skills = require('../skills');

const DEFAULT_MODELS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
];

// Claude Code prices every run as if the model were Anthropic's, which is
// wrong when the binary fronts another provider. `pricing` in the agent
// config corrects the result event:
//   { plan: 'GLM Coding Plan', monthly: 18 }
//       flat subscription → total_cost_usd 0, cost_basis 'subscription'
//   { perMillion: { input, output, cacheRead, cacheWrite } }
//       USD per 1M tokens → total_cost_usd recomputed, cost_basis 'metered'
//   { plan, monthly, perMillion }
//       subscription, but the metered figure is kept as `estimated_cost_usd`
//       so the dashboard can show what the run would have cost at list price
// `perMillion` is one rate card, or a map of model name → rate card (plus an
// optional `default`) applied per model via the CLI's `modelUsage` block.
// The CLI's own figure is kept as `reported_cost_usd`. Idempotent, so stored
// history is re-priced on load whenever the config changes.
function isRateCard(p) {
  return !!p && typeof p === 'object' &&
    ['input', 'output', 'cacheRead', 'cacheWrite'].some((k) => typeof p[k] === 'number');
}

function rateCardFor(perMillion, model) {
  if (isRateCard(perMillion)) return perMillion;
  const want = String(model || '').toLowerCase();
  const key = Object.keys(perMillion).find((k) => k !== 'default' && k.toLowerCase() === want);
  const card = (key && perMillion[key]) || perMillion.default;
  return isRateCard(card) ? card : null;
}

function tokenCost(p, input, output, cacheRead, cacheWrite) {
  return ((input || 0) * (p.input || 0) +
    (output || 0) * (p.output || 0) +
    (cacheRead || 0) * (p.cacheRead ?? p.input ?? 0) +
    (cacheWrite || 0) * (p.cacheWrite ?? p.input ?? 0)) / 1e6;
}

// Per-model when the CLI breaks usage down (sub-agents may run a different
// model); otherwise the run's aggregate usage at the fallback model's rate.
// Models without a rate card contribute nothing rather than guessing.
function meteredCost(event, perMillion, fallbackModel) {
  const byModel = event.modelUsage && typeof event.modelUsage === 'object' ? Object.entries(event.modelUsage) : [];
  if (byModel.length) {
    let total = 0;
    for (const [model, m] of byModel) {
      const p = rateCardFor(perMillion, model);
      if (p) total += tokenCost(p, m.inputTokens, m.outputTokens, m.cacheReadInputTokens, m.cacheCreationInputTokens);
    }
    return total;
  }
  const p = rateCardFor(perMillion, fallbackModel);
  const u = event.usage || {};
  return p ? tokenCost(p, u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens) : 0;
}

function applyPricing(event, pricing, fallbackModel) {
  if (!pricing || typeof event.total_cost_usd !== 'number') return;
  if (typeof event.reported_cost_usd !== 'number') event.reported_cost_usd = event.total_cost_usd;
  const metered = pricing.perMillion ? meteredCost(event, pricing.perMillion, fallbackModel) : null;
  if (pricing.plan || metered === null) {
    event.total_cost_usd = 0;
    event.cost_basis = 'subscription';
    if (pricing.plan) event.plan = String(pricing.plan);
    if (metered !== null) event.estimated_cost_usd = metered;
    else delete event.estimated_cost_usd;
  } else {
    event.total_cost_usd = metered;
    event.cost_basis = 'metered';
    delete event.estimated_cost_usd;
  }
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Turns an agent's `env` config block into real environment variables.
// Values are strings, or `{ file: '~/path' }` to read a secret from disk at
// spawn time (so tokens never live in agents.config.js). Throws if a required
// file is missing/empty so the failure surfaces in the chat, not as a 401.
function resolveEnv(spec) {
  const out = {};
  for (const [key, value] of Object.entries(spec || {})) {
    if (value && typeof value === 'object' && value.file) {
      const file = expandHome(String(value.file));
      let text = '';
      try { text = fs.readFileSync(file, 'utf8').trim(); } catch {}
      if (!text) throw new Error(`${key}: no value found in ${file}`);
      out[key] = text;
    } else if (value !== undefined && value !== null) {
      out[key] = String(value);
    }
  }
  return out;
}

// Strings longer than this inside stream events get truncated before they are
// stored/broadcast, so giant tool results don't bloat history or the UI.
const MAX_STRING = 4000;

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

// Drives the `claude` CLI in headless streaming mode. Each chat message spawns
// `claude -p <msg> --output-format stream-json`, resuming the previous session
// so the conversation is continuous.
class ClaudeCodeAdapter extends BaseAdapter {
  constructor(config, ctx) {
    super(config, ctx);
    this.proc = null;
    this.stopping = false;
  }

  settingsSchema() {
    return [
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        options: [
          { value: '', label: 'Default (account setting)' },
          ...(Array.isArray(this.config.models) && this.config.models.length ? this.config.models : DEFAULT_MODELS),
        ],
        default: '',
      },
      {
        key: 'permissionMode',
        label: 'Permission mode',
        type: 'select',
        options: [
          { value: 'acceptEdits', label: 'Accept edits (file edits auto-approved)' },
          { value: 'default', label: 'Default (unapproved tools are denied)' },
          { value: 'plan', label: 'Plan mode (read-only)' },
          { value: 'bypassPermissions', label: 'Bypass permissions (⚠ full autonomy)' },
        ],
        default: 'acceptEdits',
      },
    ];
  }

  refreshAvailability() {
    if (this.isBusy()) return Promise.resolve();
    return new Promise((resolve) => {
      execFile('claude', ['--version'], { timeout: 15000 }, (err) => {
        const next = err ? 'offline' : 'online';
        if (next !== this.state) this.setState(next);
        resolve();
      });
    });
  }

  send(text) {
    if (this.proc) throw new Error('Agent is busy with another task');

    const settings = { model: '', permissionMode: 'acceptEdits', ...this.ctx.getSettings() };
    const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (settings.model) args.push('--model', settings.model);
    if (settings.permissionMode && settings.permissionMode !== 'default') {
      args.push('--permission-mode', settings.permissionMode);
    }

    // Strip nested-session markers so the spawned CLI behaves like a fresh one,
    // then layer on the agent's own env (alternate provider URL, token, model
    // aliases) so the same `claude` binary can front a different backend.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
    }
    try {
      Object.assign(env, resolveEnv(this.config.env));
    } catch (err) {
      this.emit('event', { type: 'error', text: `Agent environment: ${err.message}` });
      // Re-emit status so the manager drops the run record and drains the queue.
      this.emit('status', this.getStatus());
      return;
    }

    this.stopping = false;
    this.currentTask = text.length > 120 ? text.slice(0, 120) + '…' : text;
    this.lastActivity = Date.now();
    this.setState('working');

    const proc = spawn('claude', args, { cwd: this.ctx.getWorkspaceDir(), env });
    this.proc = proc;

    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          this.emit('event', { type: 'stderr', text: line });
          continue;
        }
        this.handleEvent(truncateDeep(event));
      }
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      this.emit('event', { type: 'error', text: `Failed to launch claude: ${err.message}` });
    });

    proc.on('close', (code) => {
      this.proc = null;
      this.currentTask = null;
      this.clearPartial();
      this.subagents.clear();
      this.lastActivity = Date.now();
      if (code !== 0 && !this.stopping) {
        this.emit('event', {
          type: 'error',
          text: `claude exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 1000)}` : ''}`,
        });
      }
      if (this.stopping) {
        this.emit('event', { type: 'meta', text: 'Run stopped by operator' });
      }
      this.setState('online');
    });
  }

  // Slash commands for the composer's `/` picker: skills and commands found
  // on disk in the current workspace and the user's ~/.claude, plus whatever
  // the CLI itself advertised in the `system init` event of the current
  // conversation (built-in and plugin skills the dashboard can't see on
  // disk). Disk entries win because they carry descriptions.
  listSkills({ reported = [] } = {}) {
    const project = skills.discover(this.ctx.getWorkspaceDir(), 'project');
    const user = skills.discover(os.homedir(), 'user');
    const agent = reported.map((name) => ({ name: String(name), description: '', source: 'agent' }));
    return skills.merge(project, user, agent);
  }

  // Skill names carried by a `system init` event, or null if it has none.
  // `skills` is the curated list; older CLIs only send `slash_commands`,
  // which also holds interactive-only built-ins and internal names.
  skillsFromInit(event) {
    if (!event || event.type !== 'system' || event.subtype !== 'init') return null;
    if (Array.isArray(event.skills)) return event.skills.map(String);
    if (Array.isArray(event.slash_commands)) {
      return event.slash_commands.map(String).filter((n) => !n.startsWith('_'));
    }
    return null;
  }

  // Re-derive a result event's cost from the agent's pricing config. Safe to
  // call repeatedly; the manager runs it over stored history on load.
  reprice(event) {
    applyPricing(event, this.config.pricing, this.model);
  }

  // Configured override wins for display; otherwise the model the CLI last
  // reported; otherwise unknown until the first run.
  getStatus() {
    const status = super.getStatus();
    const configured = (this.ctx.getSettings().model || '').trim();
    status.model = configured || this.model || null;
    return status;
  }

  // Streaming deltas: accumulate text and emit throttled 'partial' updates.
  // These are ephemeral — never stored in history; the complete 'assistant'
  // event follows and replaces them.
  handleStreamEvent(event) {
    const se = event.event || {};
    if (se.type === 'message_start') {
      this.partialText = '';
      this.partialActive = false;
    } else if (se.type === 'content_block_start') {
      this.partialActive = se.content_block?.type === 'text';
      if (this.partialActive) this.partialText = '';
    } else if (se.type === 'content_block_delta' && this.partialActive && se.delta?.type === 'text_delta') {
      this.partialText += se.delta.text;
      this.emitPartial();
    }
    if (event.session_id) this.sessionId = event.session_id;
  }

  emitPartial() {
    const now = Date.now();
    if (now - (this.lastPartialEmit || 0) < 100) {
      if (!this.partialTimer) {
        this.partialTimer = setTimeout(() => {
          this.partialTimer = null;
          this.lastPartialEmit = Date.now();
          this.emit('partial', { text: this.partialText });
        }, 100);
      }
      return;
    }
    this.lastPartialEmit = now;
    this.emit('partial', { text: this.partialText });
  }

  clearPartial() {
    clearTimeout(this.partialTimer);
    this.partialTimer = null;
    this.partialText = '';
    this.emit('partial', { text: '' });
  }

  handleEvent(event) {
    if (event.type === 'stream_event') {
      this.handleStreamEvent(event);
      return;
    }
    if (event.type === 'assistant') {
      this.clearPartial();
      // Sub-agent fan-out: a Task tool call spawns a subagent; its tool_result
      // marks completion.
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_use' && block.name === 'Task') {
          this.subagents.set(block.id, {
            id: block.id,
            type: block.input?.subagent_type || 'agent',
            description: String(block.input?.description || '').slice(0, 60),
            startedAt: Date.now(),
          });
          this.emit('status', this.getStatus());
        }
      }
    }
    if (event.type === 'user' && this.subagents.size) {
      let changed = false;
      const blocks = event.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'tool_result' && this.subagents.delete(block.tool_use_id)) changed = true;
        }
      }
      if (changed) this.emit('status', this.getStatus());
    }
    if (event.session_id) this.sessionId = event.session_id;
    if (event.type === 'system' && event.subtype === 'init' && event.model && event.model !== this.model) {
      this.model = event.model;
      this.emit('status', this.getStatus());
    }
    if (event.type === 'result') {
      this.reprice(event);
      this.totals.runs += 1;
      if (typeof event.total_cost_usd === 'number') {
        this.totals.cost += event.total_cost_usd;
        this.totals.estimated += event.estimated_cost_usd ?? event.total_cost_usd;
      }
    }
    this.lastActivity = Date.now();
    this.emit('event', event);
  }

  stop() {
    if (this.proc) {
      this.stopping = true;
      this.proc.kill('SIGTERM');
    }
  }
}

ClaudeCodeAdapter.displayName = 'Claude Code';

module.exports = ClaudeCodeAdapter;
