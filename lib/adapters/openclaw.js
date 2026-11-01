const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const BaseAdapter = require('./base');

// An OpenClaw agent reached over HTTP — the gateway's OpenAI-compatible
// chat completions API, served on the gateway port itself (needs
// gateway.http.endpoints.chatCompletions.enabled on the OpenClaw side).
// Config rides the agent's `env` block so the registry, the register form
// and secret masking work unchanged:
//   OPENCLAW_BASE_URL  e.g. http://openclaw-pi:18789 (LAN or Tailscale)
//   OPENCLAW_API_KEY   string, or { file: '~/.config/openclaw/token' }
// Each Mission Control conversation gets its own OpenClaw session: the
// gateway derives its session key from the request's `user` field, so one
// `mc_*` value per conversation keeps the WhatsApp/Telegram threads out.
// Turns are synchronous: the reply arrives whole. Aborting the request
// cancels the agent run on the OpenClaw side.
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_AGENT_TARGET = 'openclaw';

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

class OpenClawAdapter extends BaseAdapter {
  constructor(config, ctx) {
    super(config, ctx);
    // `model` on this gateway is an agent target (openclaw, openclaw/zeus…),
    // not a provider model: a configured model row wins, and /v1/models
    // discovery only fills the slot when none is set.
    const target = config.models?.[0];
    if (target?.value) this.model = String(target.value).trim();
  }

  settingsSchema() {
    return [];
  }

  endpoint() {
    const env = this.config.env || {};
    const base = envValue(env.OPENCLAW_BASE_URL).replace(/\/+$/, '');
    if (!base) throw new Error('OPENCLAW_BASE_URL is not set — edit the agent and give the OpenClaw address');
    const key = envValue(env.OPENCLAW_API_KEY);
    if (!key) throw new Error('OPENCLAW_API_KEY is empty — set gateway.auth.token on OpenClaw and put the same key here');
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

  // The gateway derives the session key from the request's `user` field —
  // one `mc_*` value per MC conversation, minted on first turn and kept for
  // the instance's life. Clear session mints a new one.
  ensureSessionKey() {
    if (!this.sessionId) {
      this.sessionId = `mc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }
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
    const timer = setTimeout(() => ctl.abort(new Error('OpenClaw did not answer within 10 minutes')), TURN_TIMEOUT_MS);

    const turn = async () => {
      this.ensureSessionKey();
      const body = {
        model: this.model || DEFAULT_AGENT_TARGET,
        messages: [{ role: 'user', content: text }],
        user: this.sessionId,
      };
      let r = await this.request('POST', '/v1/chat/completions', body, ctl.signal);
      if (r.res.status === 409) {
        // Session archived on the OpenClaw side — mint a new key and start over once.
        this.sessionId = null;
        this.ensureSessionKey();
        r = await this.request('POST', '/v1/chat/completions', { ...body, user: this.sessionId }, ctl.signal);
      }
      if (!r.res.ok) throw new Error(`OpenClaw answered ${r.res.status}: ${errText(r.data)}`);
      return r.data || {};
    };

    turn().then((data) => {
      const content = data.choices?.[0]?.message?.content;
      const out = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('') : '';
      if (data.model && data.model !== this.model) this.model = data.model;
      if (out.trim()) this.emit('event', { type: 'assistant', message: { content: [{ type: 'text', text: out }] } });
      this.totals.runs += 1;
      const u = data.usage || {};
      this.emit('event', {
        type: 'result',
        subtype: 'success',
        duration_ms: Date.now() - startTs,
        usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
      });
    }).catch((err) => {
      if (this.stopping) return;
      const cause = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : err;
      this.emit('event', { type: 'error', text: `OpenClaw: ${cause.message}` });
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

OpenClawAdapter.displayName = 'OpenClaw';

module.exports = OpenClawAdapter;
