// M10 — two-way Telegram. A long-polling getUpdates loop turns the alert
// channel into a remote control: fleet queries, prompt dispatch and stop,
// plus reply routing (replying to a run alert queues the reply text as
// that instance's next prompt). Only the paired chat is served; anything
// else is ignored. Long polling from the server — no webhook, no tunnel.
//
// The poller is the sole owner of getUpdates (Detect pairs through it).
// It runs whenever a bot token is configured; the alerts toggle gates
// outbound alerts only, so muting alerts never kills remote control.

const git = require('./git');
const { tgCall } = require('./telegram-api');

const POLL_TIMEOUT = 25;      // seconds the API holds getUpdates open
const BACKOFF_MIN = 4000;
const BACKOFF_MAX = 60000;
const MESSAGE_LIMIT = 3800;   // Telegram caps sendMessage at 4096 chars
const LIST_CAP = 30;          // max file lines in /diff, instances in listings

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const HELP = [
  '<b>Mission Control — commands</b>',
  '/status — the fleet at a glance',
  '/agents — list instances (refs for the commands below)',
  '/agent &lt;ref&gt; — one instance: run, queue, last reply',
  '/send &lt;ref&gt; &lt;text&gt; — start a run (queues if busy)',
  '/stop &lt;ref&gt; — abort the current run',
  '/last &lt;ref&gt; — last assistant reply',
  '/diff &lt;ref&gt; — uncommitted changes',
  '',
  'A ref is an instance id prefix or part of its name.',
  'Or simply reply to a run alert — your text becomes that instance\'s next prompt.',
].join('\n');

function fmtDuration(ms) {
  if (ms == null) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm';
}

class TelegramBot {
  constructor(notifier, manager, log = console) {
    this.notifier = notifier;
    this.manager = manager;
    this.log = log;
    this.offset = 0;
    this.stopped = true;
    this.backoffMs = BACKOFF_MIN;
    this.pairWaiters = [];    // Detect endpoint waiting for a chat ID
    this.abort = null;
  }

  get token() { return this.notifier.config.telegram.botToken || ''; }
  get chatId() { return this.notifier.config.telegram.chatId || ''; }

  start() {
    if (!this.token || !this.stopped) return;
    this.stopped = false;
    this.backoffMs = BACKOFF_MIN;
    this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.abort) this.abort.abort();
    const err = httpError(400, 'Telegram bot is not running');
    for (const w of this.pairWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  // Start or stop to match the current config — called after settings saves.
  sync() {
    if (this.token) this.start();
    else this.stop();
  }

  async loop() {
    while (!this.stopped) {
      try {
        this.abort = new AbortController();
        const updates = await tgCall(this.token, 'getUpdates', {
          timeout: POLL_TIMEOUT,
          offset: this.offset,
          allowed_updates: ['message', 'channel_post'],
        }, { signal: this.abort.signal });
        this.backoffMs = BACKOFF_MIN;
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handle(update);
        }
      } catch (err) {
        if (this.stopped || err.name === 'AbortError') break;
        this.log.warn(`[telegram] ${err.message} — retrying in ${Math.round(this.backoffMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, this.backoffMs));
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX);
      }
    }
  }

  /* ── Pairing (Detect) ──────────────────────────────────────────── */

  // Detect reworked for M10: nobody but the poller may read getUpdates, so
  // pairing waits for the next live message instead of the backlog.
  waitPairing(timeoutMs = 60000) {
    if (this.chatId) return Promise.resolve({ chatId: this.chatId, name: '' });
    if (this.stopped || !this.token) {
      return Promise.reject(httpError(400, 'Set the bot token first (from @BotFather), then try Detect'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.pairWaiters = this.pairWaiters.filter((w) => w !== waiter);
        reject(httpError(400, 'No message arrived — send your bot any message, then try Detect again'));
      }, timeoutMs);
      this.pairWaiters.push(waiter);
    });
  }

  pair(msg) {
    const chat = String(msg.chat.id);
    const name = msg.chat.username || msg.chat.title || msg.chat.first_name || '';
    const info = this.notifier.pairChat(chat, name);
    this.log.log(`[telegram] paired with chat ${chat}${name ? ` (${name})` : ''}`);
    for (const w of this.pairWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(info);
    }
    return this.send('🛰️ <b>Mission Control paired</b> — this chat can now control the fleet.\n\n' + HELP);
  }

  /* ── Inbound routing ───────────────────────────────────────────── */

  async handle(update) {
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) return;
    const chat = String(msg.chat.id);
    if (!this.chatId) return this.pair(msg);
    if (chat !== this.chatId) {
      this.log.warn(`[telegram] ignored message from unpaired chat ${chat}`);
      return;
    }
    try {
      await this.dispatch(msg);
    } catch (err) {
      await this.reply('⚠️ ' + this.esc(err.message || 'Command failed'), msg);
    }
  }

  async dispatch(msg) {
    const text = String(msg.text || '').trim();

    // Reply to an outbound alert → next prompt for that run's instance.
    const repliesTo = msg.reply_to_message && msg.reply_to_message.message_id;
    if (repliesTo && !text.startsWith('/')) {
      const iid = this.notifier.alertTargets.get(repliesTo);
      if (!iid) {
        return this.reply('That message is too old to reply-route — use <code>/send</code> instead.', msg);
      }
      if (!text) return this.reply('Empty reply — nothing queued.', msg);
      return this.reply(this.prompt(iid, text), msg);
    }

    if (!text.startsWith('/')) {
      return this.reply('Send /help for commands, or reply to a run alert to prompt that instance.', msg);
    }

    const cmd = text.split(/\s+/, 1)[0].toLowerCase().replace(/@[\w_]+$/, '');
    switch (cmd) {
      case '/start':
      case '/help':
        return this.reply(HELP, msg);
      case '/status':
        return this.cmdStatus(msg);
      case '/agents':
        return this.cmdAgents(msg);
      case '/agent':
        return this.cmdAgent(this.refOf(text), msg);
      case '/stop':
        return this.cmdStop(this.refOf(text), msg);
      case '/last':
        return this.cmdLast(this.refOf(text), msg);
      case '/diff':
        return this.cmdDiff(this.refOf(text), msg);
      case '/send': {
        const m = text.match(/^\/\S+\s+(\S+)\s*([\s\S]*)$/);
        return this.cmdSend(m ? m[1] : '', m ? m[2].trim() : '', msg);
      }
      case '/commit':
        return this.reply('Not yet — <code>/commit</code> is deferred (M10). Review changes in the dashboard for now.', msg);
      default:
        return this.reply('Unknown command.\n\n' + HELP, msg);
    }
  }

  // "/cmd rest of line" → "rest" (prompts with newlines only reach /send,
  // which parses the raw text itself).
  refOf(text) {
    return text.split(/\s+/, 2)[1] || '';
  }

  /* ── Instance addressing ───────────────────────────────────────── */

  // Phone ergonomics: exact id, a unique id prefix (3+ chars), or a unique
  // case-insensitive chunk of the instance name — "/send fanfair fix tests".
  resolveInstance(ref) {
    const list = this.manager.listInstances();
    if (!ref) throw httpError(400, 'Which instance? Use /agents to list them.');
    if (!list.length) throw httpError(400, 'No instances — launch one from the dashboard sidebar.');
    const exact = list.find((i) => i.id === ref);
    if (exact) return exact;
    const candidates = (matches) => (matches.length === 1
      ? matches[0]
      : { ambiguous: matches });
    let matches = [];
    if (ref.length >= 3) matches = list.filter((i) => i.id.startsWith(ref));
    if (!matches.length) {
      const needle = ref.toLowerCase();
      matches = list.filter((i) => i.name.toLowerCase().includes(needle));
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw httpError(400, `Ambiguous "${ref}" — matches:\n` + matches.map((i) => this.listLine(i)).join('\n'));
    }
    throw httpError(404, `No instance matches "${ref}" — use /agents to list them.`);
  }

  /* ── Commands ──────────────────────────────────────────────────── */

  async cmdStatus(msg) {
    const instances = this.manager.listInstances();
    if (!instances.length) return this.reply('No instances — launch one from the dashboard sidebar.', msg);
    const working = instances.filter((i) => this.manager.get(i.id).adapter.isBusy()).length;
    const head = `🛰️ <b>Fleet</b> — ${instances.length} instance${instances.length === 1 ? '' : 's'}, ${working} working`;
    const lines = instances.slice(0, LIST_CAP).map((i) => this.listLine(i, true));
    if (instances.length > LIST_CAP) lines.push(`<i>… and ${instances.length - LIST_CAP} more — /agents</i>`);
    return this.reply(head + '\n' + lines.join('\n'), msg);
  }

  async cmdAgents(msg) {
    const instances = this.manager.listInstances();
    if (!instances.length) return this.reply('No instances — launch one from the dashboard sidebar.', msg);
    const lines = instances.slice(0, LIST_CAP).map((i) => this.listLine(i));
    if (instances.length > LIST_CAP) lines.push(`<i>… and ${instances.length - LIST_CAP} more</i>`);
    return this.reply(`Instances (${instances.length}) — the <code>id</code> prefix works as a ref:\n` + lines.join('\n'), msg);
  }

  async cmdAgent(ref, msg) {
    const inst = this.resolveInstance(ref);
    const entry = this.manager.get(inst.id);
    const busy = entry.adapter.isBusy();
    const lines = [
      `<b>${this.esc(inst.name)}</b> · ${this.esc(inst.agent)} (${this.esc(inst.type || '')})`,
      `Project: ${this.esc(inst.status.project ? inst.status.project.name : '—')}`,
      `State: ${busy ? '● working' : entry.adapter.state === 'offline' ? '✖ offline' : '○ idle'}`,
    ];
    if (busy && entry.run) {
      const elapsed = Date.now() - entry.run.startedAt;
      const left = entry.run.estimateMs ? ` (~${fmtDuration(Math.max(0, entry.run.estimateMs - elapsed))} left)` : '';
      lines.push(`Run: ${this.esc(String(this.manager.lastPromptFor(entry) || '').slice(0, 80))} · ${fmtDuration(elapsed)}${left}`);
    }
    const queue = entry.queue;
    lines.push(`Queue: ${queue.length}${queue.length ? ` — next: ${this.esc(String(queue[0].text).slice(0, 60))}` : ''}`);
    const last = this.lastReply(entry);
    if (last) lines.push(`Last reply: ${this.esc(last.slice(0, 100))}${last.length > 100 ? '…' : ''}`);
    return this.reply(lines.join('\n'), msg);
  }

  async cmdSend(ref, text, msg) {
    const inst = this.resolveInstance(ref);
    if (!text) throw httpError(400, 'Usage: /send &lt;ref&gt; &lt;text&gt;');
    return this.reply(this.prompt(inst.id, text), msg);
  }

  // Send (or queue) a prompt and describe what happened — shared by /send
  // and reply routing, so both read the same on the phone.
  prompt(iid, text) {
    const r = this.manager.sendChat(iid, text, null, 'telegram');
    const entry = this.manager.get(iid);
    const head = r.queued
      ? `📥 Queued for <b>${this.esc(entry.name)}</b> (position ${r.position})`
      : `▶ Started on <b>${this.esc(entry.name)}</b>`;
    return head + `: ${this.esc(String(text).slice(0, 120))}`;
  }

  async cmdStop(ref, msg) {
    const inst = this.resolveInstance(ref);
    const entry = this.manager.get(inst.id);
    if (!entry.adapter.isBusy()) throw httpError(400, `<b>${this.esc(inst.name)}</b> isn't working`);
    this.manager.stop(inst.id);
    return this.reply(`🛑 Stop sent to <b>${this.esc(inst.name)}</b>`, msg);
  }

  async cmdLast(ref, msg) {
    const inst = this.resolveInstance(ref);
    const last = this.lastReply(this.manager.get(inst.id));
    if (!last) throw httpError(404, `No replies yet from <b>${this.esc(inst.name)}</b>`);
    return this.reply(`<b>${this.esc(inst.name)}</b> — last reply:\n\n${this.esc(last)}`, msg);
  }

  async cmdDiff(ref, msg) {
    const inst = this.resolveInstance(ref);
    const entry = this.manager.get(inst.id);
    const st = await git.status(this.manager.getWorkspaceDir(entry));
    if (!st.isRepo) throw httpError(400, `${this.esc(inst.status.project ? inst.status.project.name : 'the project')} isn't a git repo`);
    const head = [`<b>${this.esc(inst.name)}</b> — ${this.esc(st.branch || 'no branch')}`];
    if (st.ahead || st.behind) head.push(`${st.ahead}↑ ${st.behind}↓`);
    if (!st.changes.length) {
      head.push(st.lastCommit ? `✓ clean · last: ${this.esc(st.lastCommit.hash)} ${this.esc(st.lastCommit.subject)}` : '✓ clean');
      return this.reply(head.join(' · '), msg);
    }
    const shown = st.changes.slice(0, LIST_CAP);
    const lines = shown.map((c) => `<code>${c.status}</code> ${this.esc(c.path)}`);
    if (st.changes.length > LIST_CAP) lines.push(`<i>… and ${st.changes.length - LIST_CAP} more</i>`);
    head.push(`${st.changes.length} uncommitted change${st.changes.length === 1 ? '' : 's'}`);
    return this.reply(head.join(' · ') + '\n' + lines.join('\n'), msg);
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  // One instance as a listing line; verbose adds the current run.
  listLine(inst, verbose = false) {
    const entry = this.manager.get(inst.id);
    const busy = entry.adapter.isBusy();
    const state = busy ? '●' : entry.adapter.state === 'offline' ? '✖' : '○';
    let line = `${state} <code>${inst.id.slice(0, 10)}</code> ${this.esc(inst.name)}`;
    if (busy && verbose && entry.run) {
      const elapsed = Date.now() - entry.run.startedAt;
      const prompt = String(this.manager.lastPromptFor(entry) || '').slice(0, 50);
      line += ` — working: ${this.esc(prompt)} (${fmtDuration(elapsed)})`;
    } else if (busy) {
      line += ' — working';
    } else {
      line += ` — ${entry.adapter.state === 'offline' ? 'offline' : 'idle'}`;
    }
    if (entry.queue.length) line += ` · ${entry.queue.length} queued`;
    return line;
  }

  // The instance's last non-empty assistant text (M8's closing-text shape).
  lastReply(entry) {
    const history = this.manager.instanceHistory(entry.id);
    for (let i = history.length - 1; i >= 0; i--) {
      const ev = history[i];
      if (ev.type !== 'assistant') continue;
      const text = (ev.message?.content || [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
    return null;
  }

  esc(s) {
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  reply(text, msg = null) {
    return this.send(text, msg ? { replyTo: msg.message_id } : {});
  }

  // Telegram caps a message at 4096 chars: split on line boundaries, then
  // hard-slice anything still too long, and send the chunks in order.
  async send(text, { replyTo = null } = {}) {
    const chunks = [];
    let buf = '';
    for (let line of String(text).split('\n')) {
      while (line.length > MESSAGE_LIMIT) {
        chunks.push((buf ? buf + '\n' : '') + line.slice(0, MESSAGE_LIMIT - (buf ? 1 : 0)));
        buf = '';
        line = line.slice(MESSAGE_LIMIT);
      }
      const candidate = buf ? buf + '\n' + line : line;
      if (candidate.length > MESSAGE_LIMIT) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = candidate;
      }
    }
    chunks.push(buf);
    for (const chunk of chunks) await this.notifier.telegramSend(chunk, { replyTo });
  }
}

module.exports = TelegramBot;
