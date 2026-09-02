const { spawn, execFile } = require('child_process');
const BaseAdapter = require('./base');

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
          { value: 'sonnet', label: 'Sonnet' },
          { value: 'opus', label: 'Opus' },
          { value: 'haiku', label: 'Haiku' },
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

    // Strip nested-session markers so the spawned CLI behaves like a fresh one.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
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
      this.totals.runs += 1;
      if (typeof event.total_cost_usd === 'number') this.totals.cost += event.total_cost_usd;
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
