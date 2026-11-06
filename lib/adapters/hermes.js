const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const BaseAdapter = require('./base');

// A Hermes agent reached over HTTP — the same gateway that serves its
// Telegram/Slack channels, through its API server platform (needs
// API_SERVER_KEY on the Hermes side). Config rides the agent's `env` block so
// the registry, the register form and secret masking work unchanged:
//   HERMES_BASE_URL  e.g. http://hermess-mac-mini:8642 (LAN or Tailscale)
//   HERMES_API_KEY   string, or { file: '~/.config/hermes/token' }
// Each Mission Control conversation gets its own Hermes session
// (POST /api/sessions, then /api/sessions/<id>/chat), so it never shares the
// Telegram thread. Turns are synchronous: the reply arrives whole.
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

// Probes run every 20s, so 3 misses is about a minute of real outage.
const OFFLINE_AFTER_MISSES = 3;

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function envValue(spec) {
  if (spec && typeof spec === 'object' && spec.file) {
    let text = '';
    try { text = fs.readFileSync(expandHome(String(spec.file)), 'utf8').trim(); } catch {}
    return text;
  }
  return spec == null ? '' : String(spec).trim();
}

class HermesAdapter extends BaseAdapter {
  settingsSchema() {
    return [];
  }

  endpoint() {
    const env = this.config.env || {};
    const base = envValue(env.HERMES_BASE_URL).replace(/\/+$/, '');
    if (!base) throw new Error('HERMES_BASE_URL is not set — edit the agent and give the Hermes address');
    const key = envValue(env.HERMES_API_KEY);
    if (!key) throw new Error('HERMES_API_KEY is empty — set API_SERVER_KEY on Hermes and put the same key here');
    return { base, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
  }

  async refreshAvailability() {
    if (this.isBusy()) return;
    let next = 'offline';
    try {
      const { base, headers } = this.endpoint();
      const res = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        next = 'online';
        const data = await res.json().catch(() => null);
        const id = data?.data?.[0]?.id;
        if (id && !this.model) this.model = id;
      }
    } catch {}
    if (this.isBusy()) return;
    // One missed probe is a blip (Wi-Fi roam, laptop wake, a busy gateway);
    // only a run of misses flips the agent offline, which is what pings Telegram.
    this.misses = next === 'online' ? 0 : (this.misses || 0) + 1;
    if (next === 'offline' && this.state !== 'offline' && this.misses < OFFLINE_AFTER_MISSES) return;
    if (next !== this.state) this.setState(next);
  }

  async request(method, urlPath, body, signal) {
    const { base, headers } = this.endpoint();
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { res, data };
  }

  async ensureSession(signal) {
    if (this.sessionId) return;
    const id = `mc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    // Hermes rejects duplicate titles, so every session needs its own.
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const title = `Mission Control · ${this.config.name} · ${stamp} ${id.slice(-4)}`;
    const { res, data } = await this.request('POST', '/api/sessions', { id, title }, signal);
    if (!res.ok) throw new Error(`Could not open a Hermes session (${res.status}): ${errText(data)}`);
    this.sessionId = data?.id || data?.session_id || id;
  }

  send(text) {
    if (this.abort) throw new Error('Agent is busy with another task');
    this.stopping = false;
    this.lastActivity = Date.now();
    this.currentTask = text.length > 120 ? text.slice(0, 120) + '…' : text;
    this.setState('working');
    const startTs = Date.now();
    const ctl = new AbortController();
    this.abort = ctl;
    const timer = setTimeout(() => ctl.abort(new Error('Hermes did not answer within 10 minutes')), TURN_TIMEOUT_MS);

    const turn = async () => {
      await this.ensureSession(ctl.signal);
      let r = await this.request('POST', `/api/sessions/${encodeURIComponent(this.sessionId)}/chat`, { message: text }, ctl.signal);
      if (r.res.status === 404) {
        // Session vanished on the Hermes side (state.db pruned) — start over once.
        this.sessionId = null;
        await this.ensureSession(ctl.signal);
        r = await this.request('POST', `/api/sessions/${encodeURIComponent(this.sessionId)}/chat`, { message: text }, ctl.signal);
      }
      if (!r.res.ok) throw new Error(`Hermes answered ${r.res.status}: ${errText(r.data)}`);
      return r.data || {};
    };

    turn().then((data) => {
      const reply = data.message?.content;
      const out = typeof reply === 'string' ? reply : reply == null ? '' : JSON.stringify(reply);
      if (data.session_id) this.sessionId = data.session_id;
      if (data.runtime?.model) this.model = data.runtime.model;
      if (out.trim()) this.emit('event', { type: 'assistant', message: { content: [{ type: 'text', text: out }] } });
      this.totals.runs += 1;
      const failed = ['failed', 'error'].includes(String(data.status || '').toLowerCase());
      const u = data.usage || {};
      this.emit('event', {
        type: 'result',
        subtype: failed ? 'error' : 'success',
        ...(failed ? { is_error: true } : {}),
        duration_ms: Date.now() - startTs,
        usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 },
      });
    }).catch((err) => {
      if (this.stopping) return;
      const cause = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : err;
      this.emit('event', { type: 'error', text: `Hermes: ${cause.message}` });
      this.totals.runs += 1;
      this.emit('event', { type: 'result', subtype: 'error', is_error: true, duration_ms: Date.now() - startTs });
    }).finally(() => {
      clearTimeout(timer);
      this.abort = null;
      this.currentTask = null;
      this.lastActivity = Date.now();
      if (this.stopping) this.emit('event', { type: 'meta', text: 'Run stopped by operator' });
      this.setState('online');
    });
  }

  stop() {
    if (this.abort) {
      this.stopping = true;
      this.abort.abort();
    }
  }
}

function errText(data) {
  const e = data?.error;
  return (typeof e === 'string' ? e : e?.message) || 'no detail';
}

HermesAdapter.displayName = 'Hermes';

module.exports = HermesAdapter;
