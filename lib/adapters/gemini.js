const BaseAdapter = require('./base');

// Google Gemini CLI in headless mode: `gemini -p <prompt> --output-format json`
// returns one JSON document ({response, stats}) when the run completes.
// Runs are stateless — each message is independent.
class GeminiAdapter extends BaseAdapter {
  settingsSchema() {
    return [
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        options: [
          { value: '', label: 'Default (gemini config)' },
          { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
          { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        ],
        default: '',
      },
      {
        key: 'approvalMode',
        label: 'Approval mode',
        type: 'select',
        options: [
          { value: 'yolo', label: 'YOLO — auto-approve everything' },
          { value: 'auto_edit', label: 'Auto-approve edits only' },
          { value: 'default', label: 'Default (tools may be blocked headless)' },
        ],
        default: 'yolo',
      },
    ];
  }

  refreshAvailability() {
    return this.checkBinary('gemini');
  }

  send(text) {
    if (this.proc) throw new Error('Agent is busy with another task');
    const settings = { model: '', approvalMode: 'yolo', ...this.ctx.getSettings() };
    const args = ['-p', text, '--output-format', 'json'];
    if (settings.model) args.push('-m', settings.model);
    if (settings.approvalMode && settings.approvalMode !== 'default') {
      args.push('--approval-mode', settings.approvalMode);
    }

    this.model = settings.model || this.model || 'gemini';
    this.currentTask = text.length > 120 ? text.slice(0, 120) + '…' : text;
    const startTs = Date.now();

    this.runProcess('gemini', args, {
      collectStdout: true,
      onClose: ({ code, stdout, stderr, stopped }) => {
        if (stopped) return;
        let data = null;
        try {
          // The JSON document may be preceded by log lines — parse from the
          // first '{' that yields a valid document.
          const idx = stdout.indexOf('{');
          if (idx >= 0) data = JSON.parse(stdout.slice(idx));
        } catch {}
        if (data && typeof data.response === 'string') {
          if (data.response.trim()) {
            this.emit('event', { type: 'assistant', message: { content: [{ type: 'text', text: data.response }] } });
          }
          let inTok = 0, outTok = 0;
          for (const m of Object.values(data.stats?.models || {})) {
            inTok += m.tokens?.prompt || 0;
            outTok += m.tokens?.candidates || 0;
          }
          this.totals.runs += 1;
          this.emit('event', {
            type: 'result',
            subtype: 'success',
            duration_ms: Date.now() - startTs,
            usage: { input_tokens: inTok, output_tokens: outTok },
          });
        } else if (code === 0 && stdout.trim()) {
          this.emit('event', { type: 'assistant', message: { content: [{ type: 'text', text: stdout.trim() }] } });
          this.totals.runs += 1;
          this.emit('event', { type: 'result', subtype: 'success', duration_ms: Date.now() - startTs });
        } else {
          this.emit('event', {
            type: 'error',
            text: `gemini exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 800)}` : ''}`,
          });
          this.totals.runs += 1;
          this.emit('event', { type: 'result', subtype: 'error', is_error: true, duration_ms: Date.now() - startTs });
        }
      },
    });
  }
}

GeminiAdapter.displayName = 'Gemini CLI';

module.exports = GeminiAdapter;
