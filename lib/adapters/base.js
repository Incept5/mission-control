const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');

// Contract every agent adapter must fulfil. Adapters emit:
//   'status' -> full status object (state: offline | online | working)
//   'event'  -> a chat/stream event object with a `type` field
class BaseAdapter extends EventEmitter {
  constructor(config, ctx) {
    super();
    this.config = config;
    this.ctx = ctx; // { workspaceDir, getSettings() }
    this.state = 'offline';
    this.currentTask = null;
    this.sessionId = null;
    this.model = null; // model actually reported by the agent, if known
    this.lastActivity = null;
    this.totals = { cost: 0, runs: 0 };
    this.subagents = new Map(); // active sub-agents, keyed by tool-use id
    this.proc = null;
    this.stopping = false;
  }

  getStatus() {
    return {
      state: this.state,
      currentTask: this.currentTask,
      sessionId: this.sessionId,
      model: this.model,
      lastActivity: this.lastActivity,
      totals: this.totals,
      subagents: [...this.subagents.values()],
    };
  }

  // Availability check via `<cmd> --version`.
  checkBinary(cmd) {
    if (this.isBusy()) return Promise.resolve();
    return new Promise((resolve) => {
      execFile(cmd, ['--version'], { timeout: 15000 }, (err) => {
        const next = err ? 'offline' : 'online';
        if (next !== this.state) this.setState(next);
        resolve();
      });
    });
  }

  // Shared subprocess harness: spawns in the agent's workspace, optionally
  // feeds stdout to onLine (line-buffered) and/or collects it whole, and
  // handles the working→online lifecycle.
  runProcess(cmd, args, { onLine, onClose, collectStdout = false } = {}) {
    this.stopping = false;
    this.lastActivity = Date.now();
    this.setState('working');
    const proc = spawn(cmd, args, { cwd: this.ctx.getWorkspaceDir(), env: { ...process.env } });
    this.proc = proc;
    let buf = '';
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      if (collectStdout) stdout += s;
      if (!onLine) return;
      buf += s;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      this.emit('event', { type: 'error', text: `Failed to launch ${cmd}: ${err.message}` });
    });
    proc.on('close', (code) => {
      this.proc = null;
      this.currentTask = null;
      this.lastActivity = Date.now();
      if (buf.trim() && onLine) onLine(buf.trim());
      if (onClose) {
        try {
          onClose({ code, stdout, stderr, stopped: this.stopping });
        } catch (err) {
          this.emit('event', { type: 'error', text: err.message });
        }
      }
      if (code !== 0 && !this.stopping && !onClose) {
        this.emit('event', {
          type: 'error',
          text: `${cmd} exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 1000)}` : ''}`,
        });
      }
      if (this.stopping) this.emit('event', { type: 'meta', text: 'Run stopped by operator' });
      this.setState('online');
    });
  }

  setState(state) {
    this.state = state;
    this.emit('status', this.getStatus());
  }

  isBusy() {
    return this.state === 'working';
  }

  // Subclasses implement:
  async refreshAvailability() {}
  send(_text) { throw new Error('not implemented'); }

  stop() {
    if (this.proc) {
      this.stopping = true;
      this.proc.kill('SIGTERM');
    }
  }

  clearSession() {
    this.sessionId = null;
    this.totals = { cost: 0, runs: 0 };
    this.emit('status', this.getStatus());
  }

  settingsSchema() {
    return [];
  }
}

module.exports = BaseAdapter;
