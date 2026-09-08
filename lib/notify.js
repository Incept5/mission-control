const fs = require('fs');
const path = require('path');
const { tgCall } = require('./telegram-api');

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
  events: { runComplete: true, runFailed: true, agentOffline: true, renewalReminder: true, costThreshold: 0 },
  _state: { dayKey: '', dayCost: 0, costNotified: false, lastDigestDate: '', renewalNotified: {} },
};

const CURRENCY_SIGNS = { USD: '$', GBP: '£', EUR: '€' };
function fmtMoney(amount, currency = 'USD') {
  const n = Number(amount) % 1 ? Number(amount).toFixed(2) : String(amount);
  const sign = CURRENCY_SIGNS[currency];
  return sign ? sign + n : `${n} ${currency}`;
}

class Notifier {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'notifications.json');
    // M10 reply routing: outbound alert message_id → instance id, so the
    // two-way bot can route a Telegram reply back to the run that alerted.
    this.alertTargets = new Map();
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

  // Sends one message; resolves with { messageId } so callers can thread
  // replies (M10) under it. Raises Telegram's 409 as err.conflict.
  async telegramSend(text, { replyTo = null } = {}) {
    const { botToken, chatId } = this.config.telegram;
    if (!botToken) throw httpError(400, 'Telegram bot token is not set');
    if (!chatId) throw httpError(400, 'Telegram chat ID is not set — message your bot, then use Detect');
    const result = await tgCall(botToken, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    });
    return { messageId: result.message_id };
  }

  rememberAlert(messageId, iid) {
    if (!messageId || !iid) return;
    this.alertTargets.set(messageId, iid);
    while (this.alertTargets.size > 200) this.alertTargets.delete(this.alertTargets.keys().next().value);
  }

  // Pairing (M10): the two-way bot's poller — sole owner of getUpdates —
  // captures the chat ID and hands it over here.
  pairChat(chatId, name = '') {
    this.config.telegram.chatId = String(chatId);
    this.save();
    return { chatId: this.config.telegram.chatId, name };
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

  tg(text, iid = null) {
    if (!this.config.telegram.enabled) return;
    this.fire(
      this.telegramSend(text).then((r) => {
        if (iid) this.rememberAlert(r.messageId, iid);
      })
    );
  }

  esc(s) {
    return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  runFinished({ iid = null, agent, task, durationMs, cost, failed, queueLen, project }) {
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
      (parts || suffix ? `\n${parts}${suffix}` : '') +
      `\n<i>Reply to route your next prompt</i>`,
      iid
    );
  }

  runError(agent, text, iid = null) {
    if (!this.config.events.runFailed) return;
    this.tg(
      `❌ <b>${this.esc(agent)}</b> error: ${this.esc(String(text).slice(0, 200))}` +
      `\n<i>Reply to route your next prompt</i>`,
      iid
    );
  }

  agentOffline(agent) {
    if (!this.config.events.agentOffline) return;
    this.tg(`⚠️ <b>${this.esc(agent)}</b> went offline`);
  }

  // Subscription renewal reminder (M15): once per agent per renewal date, on
  // every enabled channel — Telegram message and, if email is on, a mail.
  renewalDue({ agentId, agent, plan, amount, currency, period, renewsOn, daysToRenewal }) {
    if (!this.config.events.renewalReminder) return;
    const st = this.config._state;
    if (!st.renewalNotified || typeof st.renewalNotified !== 'object') st.renewalNotified = {};
    if (st.renewalNotified[agentId] === renewsOn) return;
    st.renewalNotified[agentId] = renewsOn;
    this.save();
    const price = typeof amount === 'number' ? ` — ${fmtMoney(amount, currency)}/${period === 'year' ? 'yr' : 'mo'}` : '';
    const when = daysToRenewal <= 0 ? 'renews today' : `renews tomorrow (${renewsOn})`;
    this.tg(`🔔 <b>${this.esc(agent)}</b> · ${this.esc(plan)} ${when}${price}`);
    if (this.config.email.enabled) {
      const subject = `Mission Control — ${agent} subscription ${when}`;
      const text = `${agent}: ${plan} ${when}${price}.`;
      this.fire(this.emailSend(subject, `<p>${this.esc(text)}</p>`, text));
    }
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
