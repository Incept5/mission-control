const BaseAdapter = require('./base');

// OpenCode in headless mode: `opencode run <prompt>` prints the response text.
// `-c` continues the most recent session in the working directory, giving
// conversation continuity per workspace/project.
class OpencodeAdapter extends BaseAdapter {
  settingsSchema() {
    return [
      {
        key: 'model',
        label: 'Model (provider/model)',
        type: 'text',
        placeholder: 'e.g. anthropic/claude-sonnet-4-5 (empty = default)',
        default: '',
      },
      {
        key: 'continueSession',
        label: 'Session continuity',
        type: 'select',
        options: [
          { value: 'yes', label: 'Continue previous session (-c)' },
          { value: 'no', label: 'Fresh session each message' },
        ],
        default: 'yes',
      },
    ];
  }

  refreshAvailability() {
    return this.checkBinary('opencode');
  }

  send(text) {
    if (this.proc) throw new Error('Agent is busy with another task');
    const settings = { model: '', continueSession: 'yes', ...this.ctx.getSettings() };
    const args = ['run'];
    if (settings.model) args.push('-m', settings.model);
    if (settings.continueSession === 'yes' && this.hasRun) args.push('-c');

    // Fleet vault (spawn-time grant): MCP server via a `--config` JSON
    // override (opencode's mcp schema: command as argv array), fleet context
    // prepended to the prompt.
    const vault = this.ctx.getVaultSpawn ? this.ctx.getVaultSpawn() : null;
    const prompt = vault ? `${vault.preamble}\n\n---\n\n${text}` : text;
    if (vault) {
      args.push('--config', JSON.stringify({
        mcp: {
          vault: {
            type: 'local',
            command: [vault.mcp.command, ...vault.mcp.args],
            enabled: true,
            environment: vault.mcp.env,
          },
        },
      }));
    }
    args.push(prompt);

    this.model = settings.model || this.model || 'opencode';
    this.currentTask = text.length > 120 ? text.slice(0, 120) + '…' : text;
    const startTs = Date.now();

    this.runProcess('opencode', args, {
      collectStdout: true,
      onClose: ({ code, stdout, stderr, stopped }) => {
        if (stopped) return;
        if (code === 0) {
          const out = stdout.trim();
          if (out) {
            this.emit('event', { type: 'assistant', message: { content: [{ type: 'text', text: out.slice(0, 20000) }] } });
          }
          this.hasRun = true;
          this.totals.runs += 1;
          this.emit('event', { type: 'result', subtype: 'success', duration_ms: Date.now() - startTs });
        } else {
          this.emit('event', {
            type: 'error',
            text: `opencode exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 800)}` : ''}`,
          });
          this.totals.runs += 1;
          this.emit('event', { type: 'result', subtype: 'error', is_error: true, duration_ms: Date.now() - startTs });
        }
      },
    });
  }

  clearSession() {
    super.clearSession();
    this.hasRun = false;
  }
}

OpencodeAdapter.displayName = 'OpenCode';

module.exports = OpencodeAdapter;
