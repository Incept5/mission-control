const BaseAdapter = require('./base');

// OpenAI Codex CLI in headless mode: `codex exec --json` emits JSONL events
// which we map onto the dashboard's event shapes. Sessions resume via
// `codex exec resume <thread_id>`.
class CodexAdapter extends BaseAdapter {
  settingsSchema() {
    return [
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        options: [
          { value: '', label: 'Default (codex config)' },
          { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
          { value: 'gpt-5', label: 'GPT-5' },
        ],
        default: '',
      },
      {
        key: 'sandbox',
        label: 'Sandbox',
        type: 'select',
        options: [
          { value: 'workspace-write', label: 'Workspace write (default)' },
          { value: 'read-only', label: 'Read only' },
          { value: 'danger-full-access', label: '⚠ Full access' },
        ],
        default: 'workspace-write',
      },
    ];
  }

  refreshAvailability() {
    return this.checkBinary('codex');
  }

  send(text) {
    if (this.proc) throw new Error('Agent is busy with another task');
    const settings = { model: '', sandbox: 'workspace-write', ...this.ctx.getSettings() };
    const args = ['exec'];
    if (this.sessionId) args.push('resume', this.sessionId);
    args.push('--json', '--skip-git-repo-check', '--sandbox', settings.sandbox);
    if (settings.model) args.push('-m', settings.model);
    args.push(text);

    this.model = settings.model || this.model || 'codex';
    this.currentTask = text.length > 120 ? text.slice(0, 120) + '…' : text;
    const startTs = Date.now();

    this.runProcess('codex', args, {
      onLine: (line) => {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          return;
        }
        this.handleCodexEvent(obj, startTs);
      },
      onClose: ({ code, stderr, stopped }) => {
        if (code !== 0 && !stopped) {
          this.emit('event', {
            type: 'error',
            text: `codex exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 800)}` : ''}`,
          });
        }
      },
    });
  }

  handleCodexEvent(obj, startTs) {
    const type = obj.type;
    if (type === 'thread.started') {
      this.sessionId = obj.thread_id || this.sessionId;
      this.emit('event', { type: 'system', subtype: 'init', session_id: this.sessionId, model: this.model });
      this.emit('status', this.getStatus());
    } else if (type === 'item.completed') {
      const item = obj.item || {};
      if (item.type === 'agent_message' && item.text) {
        this.emit('event', { type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
      } else if (item.type === 'command_execution') {
        this.emit('event', {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: item.id || 'cmd', name: 'shell', input: { command: item.command } }] },
        });
        if (item.aggregated_output) {
          this.emit('event', {
            type: 'user',
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: item.id || 'cmd',
                is_error: item.exit_code !== undefined && item.exit_code !== 0,
                content: String(item.aggregated_output).slice(0, 4000),
              }],
            },
          });
        }
      } else if (item.type === 'file_change') {
        this.emit('event', {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: item.id || 'patch', name: 'apply_patch', input: { changes: item.changes } }] },
        });
      } else if (item.type === 'mcp_tool_call') {
        this.emit('event', {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: item.id || 'mcp', name: item.tool || 'mcp', input: item.arguments || {} }] },
        });
      } else if (item.type === 'error') {
        this.emit('event', { type: 'error', text: String(item.message || 'codex error') });
      }
    } else if (type === 'turn.completed') {
      this.totals.runs += 1;
      const u = obj.usage || {};
      this.emit('event', {
        type: 'result',
        subtype: 'success',
        duration_ms: Date.now() - startTs,
        usage: {
          input_tokens: u.input_tokens || 0,
          cache_read_input_tokens: u.cached_input_tokens || 0,
          output_tokens: u.output_tokens || 0,
        },
      });
    } else if (type === 'turn.failed') {
      this.totals.runs += 1;
      this.emit('event', {
        type: 'result',
        subtype: 'error',
        is_error: true,
        duration_ms: Date.now() - startTs,
      });
      if (obj.error?.message) this.emit('event', { type: 'error', text: obj.error.message });
    } else if (type === 'error') {
      this.emit('event', { type: 'error', text: String(obj.message || 'codex error') });
    }
  }
}

CodexAdapter.displayName = 'Codex CLI';

module.exports = CodexAdapter;
