const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const DEFAULTS = {
  telegram: { enabled: false, botToken: '', chatId: '' },
  email: {
    enabled: false,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    from: '',
    to: '',
    digestHour: 8,
  },
  events: { runComplete: true, runFailed: true, agentOffline: true, costThreshold: 0 },
  _state: { dayKey: '', dayCost: 0, costNotified: false, lastDigestDate: '' },
};

class Notifier {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'notifications.json');
    const saved = readJson(this.file, {});
    this.config = {
      telegram: { ...DEFAULTS.telegram, ...saved.telegram },
      email: { ...DEFAULTS.email, ...saved.email },
      events: { ...DEFAULTS.events, ...saved.events },
      _state: { ...DEFAULTS._state, ...saved._state },
    };
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.config, null, 2));
  }

  getConfig() {
    const { _state, ...rest } = this.config;
    return rest;
  }

  update(patch) {
    for (const section of ['telegram', 'email', 'events']) {
      if (patch[section] && typeof patch[section] === 'object') {
        this.config[section] = { ...this.config[section], ...patch[section] };
      }
    }
    this.save();
    return this.getConfig();
  }

  /* ── Telegram ──────────────────────────────────────────────────── */

  async telegramSend(text) {
    const { botToken, chatId } = this.config.telegram;
    if (!botToken) throw httpError(400, 'Telegram bot token is not set');
    if (!chatId) throw httpError(400, 'Telegram chat ID is not set — message your bot, then use Detect');
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw httpError(400, 'Telegram: ' + (data.description || res.statusText));
    return true;
  }

  async detectChatId() {
    const { botToken } = this.config.telegram;
    if (!botToken) throw httpError(400, 'Set the bot token first (from @BotFather)');
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw httpError(400, 'Telegram: ' + (data.description || 'getUpdates failed'));
    const messages = (data.result || []).map((u) => u.message || u.channel_post).filter(Boolean);
    if (!messages.length) {
      throw httpError(400, 'No messages found — open Telegram, send your bot any message, then try again');
    }
    const chat = messages[messages.length - 1].chat;
    this.config.telegram.chatId = String(chat.id);
    this.save();
    return { chatId: this.config.telegram.chatId, name: chat.username || chat.title || chat.first_name || '' };
  }

  /* ── Email ─────────────────────────────────────────────────────── */

  transporter() {
    const nodemailer = require('nodemailer');
    const e = this.config.email;
    if (!e.smtpHost) throw httpError(400, 'SMTP host is not set');
    return nodemailer.createTransport({
      host: e.smtpHost,
      port: +e.smtpPort || 587,
      secure: !!e.smtpSecure,
      auth: e.smtpUser ? { user: e.smtpUser, pass: e.smtpPass } : undefined,
    });
  }

  async emailSend(subject, html, text) {
    const e = this.config.email;
    if (!e.to) throw httpError(400, 'Recipient address is not set');
    await this.transporter().sendMail({ from: e.from || e.smtpUser || e.to, to: e.to, subject, html, text });
    return true;
  }

  /* ── Event notifications (fire-and-forget) ─────────────────────── */

  fire(promise) {
    promise.catch((err) => console.warn('[notify]', err.message));
  }

  tg(text) {
    if (this.config.telegram.enabled) this.fire(this.telegramSend(text));
  }

  esc(s) {
    return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  runFinished({ agent, task, durationMs, cost, failed, queueLen, project }) {
    const events = this.config.events;
    if (failed ? !events.runFailed : !events.runComplete) return;
    const icon = failed ? '❌' : '✅';
    const parts = [
      durationMs ? (durationMs / 1000).toFixed(0) + 's' : '',
      typeof cost === 'number' ? '$' + cost.toFixed(3) : '',
    ].filter(Boolean).join(' · ');
    const suffix = queueLen ? ` — ${queueLen} still queued` : '';
    const proj = project ? ` [${this.esc(project)}]` : '';
    this.tg(
      `${icon} <b>${this.esc(agent)}</b>${proj} ${failed ? 'run failed' : 'finished'}: ${this.esc(String(task || '').slice(0, 120))}` +
      (parts || suffix ? `\n${parts}${suffix}` : '')
    );
  }

  runError(agent, text) {
    if (!this.config.events.runFailed) return;
    this.tg(`❌ <b>${this.esc(agent)}</b> error: ${this.esc(String(text).slice(0, 200))}`);
  }

  agentOffline(agent) {
    if (!this.config.events.agentOffline) return;
    this.tg(`⚠️ <b>${this.esc(agent)}</b> went offline`);
  }

  addCost(cost) {
    const today = new Date().toISOString().slice(0, 10);
    const st = this.config._state;
    if (st.dayKey !== today) {
      st.dayKey = today;
      st.dayCost = 0;
      st.costNotified = false;
    }
    st.dayCost += cost;
    const threshold = +this.config.events.costThreshold || 0;
    if (threshold > 0 && !st.costNotified && st.dayCost >= threshold) {
      st.costNotified = true;
      this.tg(`💸 Daily spend crossed <b>$${threshold.toFixed(2)}</b> (now $${st.dayCost.toFixed(2)})`);
    }
    this.save();
  }

  /* ── Daily digest ──────────────────────────────────────────────── */

  buildDigest(data) {
    const date = new Date().toLocaleDateString();
    const totalRuns = data.agents.reduce((s, a) => s + a.runs, 0);
    const totalCost = data.agents.reduce((s, a) => s + a.cost, 0);
    const rows = data.agents.map((a) =>
      `<tr><td style="padding:6px 12px">${this.esc(a.name)}</td>` +
      `<td style="padding:6px 12px;text-align:right">${a.runs}</td>` +
      `<td style="padding:6px 12px;text-align:right">${a.failures}</td>` +
      `<td style="padding:6px 12px;text-align:right">$${a.cost.toFixed(3)}</td></tr>`
    ).join('');
    const taskItems = data.tasks.length
      ? '<ul>' + data.tasks.map((t) =>
          `<li>${this.esc(t.title)} — <b>${t.column}</b>${t.project ? ` (${this.esc(t.project)})` : ''}</li>`
        ).join('') + '</ul>'
      : '<p>No cards reached Review or Done.</p>';
    const html =
      `<h2>🛰️ Mission Control — daily digest</h2>` +
      `<p>${totalRuns} runs · $${totalCost.toFixed(3)} spend in the last 24 hours.</p>` +
      `<table style="border-collapse:collapse;border:1px solid #ddd">` +
      `<tr style="background:#f4f4f4"><th style="padding:6px 12px;text-align:left">Agent</th>` +
      `<th style="padding:6px 12px">Runs</th><th style="padding:6px 12px">Failures</th><th style="padding:6px 12px">Cost</th></tr>` +
      rows + `</table>` +
      `<h3>Board activity</h3>` + taskItems;
    const text =
      `Mission Control daily digest\n${totalRuns} runs, $${totalCost.toFixed(3)} in the last 24h.\n` +
      data.agents.map((a) => `${a.name}: ${a.runs} runs, ${a.failures} failures, $${a.cost.toFixed(3)}`).join('\n');
    return { subject: `Mission Control digest — ${date}`, html, text };
  }

  async sendDigest(data) {
    const { subject, html, text } = this.buildDigest(data);
    await this.emailSend(subject, html, text);
    this.config._state.lastDigestDate = new Date().toISOString().slice(0, 10);
    this.save();
  }

  maybeDigest(getData) {
    const e = this.config.email;
    if (!e.enabled) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (this.config._state.lastDigestDate === today) return;
    if (now.getHours() < (+e.digestHour || 8)) return;
    this.fire(this.sendDigest(getData()));
  }
}

module.exports = Notifier;
