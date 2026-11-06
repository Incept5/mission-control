const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const BaseAdapter = require('./base');

// A model behind any OpenAI-compatible chat completions API — inferd,
// vLLM, llama.cpp's server, mlx_lm.server — talked to directly: no agent
// harness, so it chats but has no tools. Config rides the agent's `env`
// block so the registry, the register form and secret masking work unchanged:
//   OPENAI_BASE_URL  the API root including /v1, e.g. http://hermess-mac-mini:8300/v1
//   OPENAI_API_KEY   optional (self-hosted servers usually take none); string or { file }
// Unlike Hermes and OpenClaw the server keeps no session, so Mission Control
// does: each conversation's messages live in data/openai-chats/<session>.json
// and the whole history rides every turn (inferd's prefix cache makes the
// repeated prefix cheap). Replies stream, so the chat fills in as it decodes.
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

// Probes run every 20s, so 3 misses is about a minute of real outage.
const OFFLINE_AFTER_MISSES = 3;

const CHATS_DIR = path.join(process.env.MC_ROOT || path.join(__dirname, '..', '..'), 'data', 'openai-chats');

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

// Reasoning models that put their thinking inline (<think>…</think>) rather
// than in reasoning_content: keep only the answer.
function stripThink(text) {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '').replace(/^\s*<think>[\s\S]*$/, '');
}

class OpenAIAdapter extends BaseAdapter {
  constructor(config, ctx) {
    super(config, ctx);
    this.messages = null; // loaded lazily for the current sessionId
  }

  settingsSchema() {
    const models = Array.isArray(this.config.models) ? this.config.models : [];
    return [
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        options: [{ value: '', label: 'Default (first model the server lists)' }, ...models],
        default: '',
      },
      {
        key: 'thinking',
        label: 'Thinking',
        type: 'select',
        options: [
          { value: '', label: 'Server default' },
          { value: 'off', label: 'Off (answer directly)' },
          { value: 'on', label: 'On (reason first)' },
        ],
        default: '',
      },
    ];
  }

  getStatus() {
    const status = super.getStatus();
    status.model = this.chosenModel() || null;
    return status;
  }

  chosenModel() {
    return (this.ctx.getSettings().model || '').trim() || this.config.models?.[0]?.value || this.model;
  }

  endpoint() {
    const env = this.config.env || {};
    const base = envValue(env.OPENAI_BASE_URL).replace(/\/+$/, '');
    if (!base) throw new Error('OPENAI_BASE_URL is not set — edit the agent and give the server address, ending in /v1');
    const key = envValue(env.OPENAI_API_KEY);
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    return { base, headers };
  }

  async refreshAvailability() {
    if (this.isBusy()) return;
    let next = 'offline';
    try {
      const { base, headers } = this.endpoint();
      const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        next = 'online';
        const data = await res.json().catch(() => null);
        const id = data?.data?.[0]?.id;
        if (id) this.model = id;
      }
    } catch {}
    if (this.isBusy()) return;
    // One missed probe is a blip (Wi-Fi roam, laptop wake, a busy server);
    // only a run of misses flips the agent offline, which is what pings Telegram.
    this.misses = next === 'online' ? 0 : (this.misses || 0) + 1;
    if (next === 'offline' && this.state !== 'offline' && this.misses < OFFLINE_AFTER_MISSES) return;
    if (next !== this.state) this.setState(next);
  }

  /* ── Conversation store ───────────────────────────────────────── */

  chatFile(id) {
    if (!/^mc_[A-Za-z0-9_]+$/.test(id)) throw new Error('Invalid session id');
    return path.join(CHATS_DIR, `${id}.json`);
  }

  loadMessages() {
    if (this.messages) return this.messages;
    this.messages = [];
    if (this.sessionId) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.chatFile(this.sessionId), 'utf8'));
        if (Array.isArray(saved)) this.messages = saved;
      } catch {}
    }
    return this.messages;
  }

  saveMessages() {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const file = this.chatFile(this.sessionId);
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.messages));
    fs.renameSync(file + '.tmp', file);
  }

  ensureSession() {
    if (!this.sessionId) {
      this.sessionId = `mc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      this.messages = [];
    }
  }

  clearSession() {
    if (this.sessionId) {
      try { fs.unlinkSync(this.chatFile(this.sessionId)); } catch {}
    }
    this.messages = null;
    super.clearSession();
  }

  /* ── Turns ────────────────────────────────────────────────────── */

  requestBody(messages, { stream }) {
    const body = { messages, stream };
    const model = this.chosenModel();
    if (model) body.model = model;
    if (stream) body.stream_options = { include_usage: true };
    const thinking = this.ctx.getSettings().thinking;
    // chat_template_kwargs is what inferd, vLLM and SGLang read; servers
    // without a thinking switch ignore it.
    if (thinking === 'on' || thinking === 'off') body.chat_template_kwargs = { enable_thinking: thinking === 'on' };
    return body;
  }

  // POST /chat/completions with stream: true; resolves { text, usage, model }.
  // Text deltas go out as throttled 'partial' events; reasoning deltas are
  // dropped (the chat shows the answer, like the other adapters).
  async streamTurn(messages, signal) {
    const { base, headers } = this.endpoint();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(this.requestBody(messages, { stream: true })),
      signal,
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch {}
      throw new Error(`server answered ${res.status}: ${errText(data)}`);
    }
    let text = '';
    let usage = null;
    let model = null;
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.error) throw new Error(errText(ev));
        if (ev.model) model = ev.model;
        if (ev.usage) usage = ev.usage;
        const delta = ev.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          text += delta;
          this.partialText = stripThink(text);
          this.emitPartial();
        }
      }
    }
    return { text: stripThink(text).trim(), usage, model };
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
    const timer = setTimeout(() => ctl.abort(new Error('the server did not finish within 10 minutes')), TURN_TIMEOUT_MS);

    this.ensureSession();
    const history = this.loadMessages();
    const messages = [...history, { role: 'user', content: text }];

    this.streamTurn(messages, ctl.signal).then(({ text: out, usage, model }) => {
      if (model) this.model = model;
      // The turn only joins the history once it has an answer, so a failed
      // or stopped turn can simply be sent again.
      history.push({ role: 'user', content: text }, { role: 'assistant', content: out });
      this.saveMessages();
      if (out) this.emit('event', { type: 'assistant', message: { content: [{ type: 'text', text: out }] } });
      this.totals.runs += 1;
      const u = usage || {};
      this.emit('event', {
        type: 'result',
        subtype: 'success',
        duration_ms: Date.now() - startTs,
        usage: {
          input_tokens: Math.max(0, (u.prompt_tokens || 0) - (u.prompt_tokens_details?.cached_tokens || 0)),
          cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens || 0,
          output_tokens: u.completion_tokens || 0,
        },
      });
    }).catch((err) => {
      if (this.stopping) return;
      const cause = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : err;
      this.emit('event', { type: 'error', text: `${this.config.name}: ${cause.message}` });
      this.totals.runs += 1;
      this.emit('event', { type: 'result', subtype: 'error', is_error: true, duration_ms: Date.now() - startTs });
    }).finally(() => {
      clearTimeout(timer);
      this.clearPartial();
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

  // Side-channel ask (M23): one request outside the conversation, no events.
  async oneShot(prompt) {
    try {
      const { base, headers } = this.endpoint();
      const body = this.requestBody([{ role: 'user', content: prompt }], { stream: false });
      body.chat_template_kwargs = { enable_thinking: false };
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content;
      return typeof out === 'string' ? stripThink(out).trim() || null : null;
    } catch {
      return null;
    }
  }

  // Streaming deltas, throttled to one 'partial' per 100 ms like claude-code;
  // ephemeral, replaced by the complete 'assistant' event.
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
}

function errText(data) {
  const e = data?.error;
  return (typeof e === 'string' ? e : e?.message) || data?.detail || 'no detail';
}

OpenAIAdapter.displayName = 'OpenAI-compatible model';

module.exports = OpenAIAdapter;
