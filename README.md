# 🛰️ Mission Control

A local operating dashboard for managing AI agents. Runs entirely on your
machine — no cloud, no accounts.

## Run it

```sh
npm install
npm start
```

Then open **http://localhost:1969** (Apollo 11 vintage — override with `PORT=xxxx npm start`).

## What you get

- **Dashboard** — live fleet view: which agents are online, working, or offline,
  what each one is doing right now, run counts and session spend. Updates in
  real time over WebSockets.
- **Live CLI sessions** — the dashboard also detects Claude Code tabs you run
  yourself in any terminal (wrapper aliases that set `ANTHROPIC_BASE_URL`
  included): open `claude` processes are merged with fresh writes to the
  native session store (`~/.claude/projects`), so each row shows the folder,
  model, branch, and what the tab is working on. A pulsing dot means it wrote
  to its transcript in the last two minutes; idle-but-open tabs stay listed.
- **Run origin & time estimate** — a working card (and the agent header,
  working bar, chat prompt, session list, and activity feed) shows where the
  run came from: `💬 chat`, `⌗ board · <card>`, or `⧗ queue ← …` for a run
  that waited in the queue. Beside it a live clock shows elapsed time and
  `~N left` / `N over` against an estimate: the median of this agent's past
  successful runs on the same project (falling back to the agent, then the
  whole fleet), refined as tool calls come in. Hover the clock for the basis.
  It's informational only — nothing alerts when a run overshoots.
- **Per-agent Chat** — a streaming chat panel. For Claude Code you see its
  tool calls (⚙ chips) and results (✓ chips) live as it works.
- **Per-agent Workspace** — a folder tree of the agent's working directory
  (`workspaces/<agent-id>/`, or the project root when a project is selected):
  expand folders in place, view, create, and edit files. "💬 Ask in chat" on an
  open file adds it to the next chat message. The agent runs with this
  directory as its cwd, so anything it builds shows up here.
- **Per-agent Control Room** — model & permission-mode settings, session info,
  abort / new session / clear history, and a raw telemetry event stream.

## Chat features

- **Live streaming** — assistant text streams word-by-word (▊ cursor) and is
  replaced by the final message when the turn completes.
- **Project files as context** — 🗂 in the composer opens a file tree of the
  agent's current workspace beside the chat. Drag any file or folder into the
  message (or hover a row and press +) to stage it as a reference chip; the
  sent message lists the absolute paths and tells the agent to read them, so
  you can drop in a document and ask questions about it. Folders are listed
  as such so the agent explores them first. Nothing is copied.
- **Attachments** — paste, drag-drop from the OS, or 📎 files/images into the
  composer (20MB max each). They're saved under `.attachments/` in the agent's
  current workspace and the message tells the agent to read them for context.
- **Slash commands** — type `/` at the start of a message to pick from the
  skills the agent can run: `.claude/skills` and `.claude/commands` in its
  current project, the same under `~/.claude`, and whatever the CLI reported
  in its last session (built-in and plugin skills). Filters as you type;
  Enter/Tab inserts, Esc dismisses.
- **Prompt library** — ☰ in the composer lists saved prompts (global or scoped
  to the agent's current project) and inserts them; "Manage prompts…" adds,
  edits, and deletes (stored in `data/prompts.json`).
- **Voice prompting** — 🎤 in the composer, picked per use: record a clip that
  the server transcribes with the Whisper API (set your OpenAI key from the
  picker's "Whisper settings…"), or dictate live with the browser's built-in
  speech recognition (no key, any adapter). Either way the text lands in the
  composer as editable text — nothing is sent until you press Send. Recordings
  cap at 2 minutes; the key lives under `_voice` in `data/settings.json`.
- **Session export** — in a session's detail view: ⧉ Copy or ⬇ Export the
  transcript as Markdown.

## Multiple agents & the task queue

- **Spawn agents from the UI** — "+ New agent" in the sidebar (or the dashed
  card on the dashboard). Each instance gets its own sessions, project pointer,
  workspace (`workspaces/<id>/`), and settings. UI-created agents live in
  `data/agents.json`; retire one from its Control Room (history is deleted,
  workspace files are kept). Agents in `agents.config.js` can't be retired
  from the UI.
- **Task queue** — messages sent while an agent is busy queue up and run in
  order automatically. The queue shows above the composer (reorder with ↑/↓,
  cancel with ✕), survives server restarts, and keeps draining after an
  aborted run.

## Analytics

The **Analytics** page rolls up the retained event history (last 1000
events/agent):

- Stat tiles (spend today / 7 days, runs, success rate, avg run) and a daily
  budget bar when a cost threshold is set on the Alerts page.
- Cost-by-day chart (14 days, hover for per-agent breakdown), cost by agent,
  cost by project.
- Run outcomes table: runs, failures, success %, avg/longest duration, tokens
  in/out, cost per agent.
- Project health cards: git branch + uncommitted count, runs/cost, open board
  cards, agents pointed there, last activity.
- Global activity feed across all agents (starts, finishes, failures, project
  switches) — click a row to jump to that agent. Live-updates as runs happen.

## Alerts

The **Alerts** page wires external notifications (config in
`data/notifications.json`):

- **Telegram (instant)**: create a bot with @BotFather, paste the token, send
  the bot any message, click **Detect** to capture your chat ID, then
  **Send test message**. Alerts: run completed (with duration/cost/queue
  depth), run failed, agent went offline, and daily spend crossing your
  threshold.
- **Email (daily digest)**: SMTP settings + recipient + send hour. The digest
  covers the last 24h — runs/failures/cost per agent and board activity.
  **Send digest now** previews it immediately.
- Event toggles let you mute categories; cost threshold `0` disables spend
  alerts.

## Board (kanban)

The **Board** page (sidebar) is a per-project kanban: Backlog → In progress →
Review → Done. Pick the project (or the default workspace) from the dropdown.

- **+ Add card** in Backlog; click a card to edit or delete it. Cards persist
  in `data/tasks.json`.
- **Dispatch**: drag a card onto an agent chip (top right), or use the card's
  ▶ menu. Dispatching points the agent at the card's project (when idle — a
  cross-project dispatch to a busy agent is refused), then runs the card's
  title + description as the prompt, queueing if the agent is mid-run.
- Cards follow their run automatically: **In progress** while running/queued,
  then **Review** when the run completes (badged `failed`/`stopped` when it
  didn't succeed). 🗂 on a card jumps to the exact session that did the work;
  ✓ marks it Done.
- Drag between columns to move cards manually. Removing a project moves its
  cards to the default-workspace board.

## Git tab

Each agent has a **Git** tab operating on its current workspace (the project
root when one is selected):

- Changed files with status markers; click for a per-file diff, `∑ All changes`
  for the full uncommitted diff (staged + unstaged + untracked).
- Commit box (stages everything, `git add -A` + commit), branch switcher and
  new-branch button, recent-commit history with full patch view.
- ↩ discards a file's changes (restores tracked files from HEAD, deletes
  untracked ones — confirmed first).
- Not a repo? One-click `git init`. Repository discovery is deliberately capped
  at the workspace folder so a non-repo workspace can never read or write a
  repo in a parent directory.
- The pane auto-refreshes when a run finishes.

Sessions also show a `✎ N files` chip — the files that session's tool calls
touched (hover for the list).

## Projects

Projects are first-class: register any folder on disk (the **Projects** page in
the sidebar — name, root path, description; `~` is expanded). Then point an
agent at a project from the dropdown in the agent's header:

- The agent runs with the project root as its working directory, so it picks up
  that project's own `CLAUDE.md`, `.claude/` config, and memory automatically.
- The Workspace tab and the chat's 🗂 files panel browse the project root.
- Each project keeps its own session per agent — switch away and back and the
  agent resumes the conversation where it left off.
- Removing a project only unregisters it; files on disk are never touched.
- **🧠 History**: each project card shows how many *native* Claude Code
  sessions exist for its folder (read from `~/.claude/projects/…`), and the
  History button opens a full transcript browser — covering every session run
  from that folder in any terminal, not just through this dashboard, plus a
  "from parent folders" section for sessions opened in the repo's parent or a
  monorepo root. Transcripts are read-only, exportable as Markdown.

Project registrations live in `data/projects.json`, per-agent project/session
pointers in `data/state.json`.

## Fleet vault

Every agent run is granted access to a **shared vault** — a plain Markdown
folder that is its own git repo, so the fleet builds one common memory instead
of four separate ones. The vault lives outside this repo (default
`../fleet-vault`, a sibling); point Mission Control at your own folder — e.g.
an Obsidian vault — via the `_vault.path` key in `data/settings.json`, or
`PUT /api/vault {"path": "…"}`. Set `_vault.enabled: false` to turn it off.

Layout: `notes/` for agent-written notes, `_catalog/` for one auto-maintained
page per registered project, `_mc/` for Mission Control's own distilled
decisions. Notes carry frontmatter — `type` (project-note | convention |
decision | gotcha | how-to), `project` (optional), `tags`, `author`,
`updated` — and sit flat in `notes/`.

MC maintains its own folders: catalog pages are written on registration and
refreshed on project edits, agent assignment, and every finished run (a
day-granular last-activity stamp); unregistering marks a page `retired`
rather than deleting it. `_mc/` holds one note per planning round, distilled
from `ROADMAP.md` on boot. Refreshes never clobber agent additions — foreign
frontmatter keys and appended sections survive, and unchanged content skips
the write entirely.

At spawn each run gets two things:

- a short **preamble** (fleet catalog, its own project's page, and the three
  rules: search before assuming, write durable learnings, append rather than
  duplicate) — via `--append-system-prompt` on Claude Code, prepended to the
  prompt elsewhere;
- the **vault MCP server** (`vault_search`, `vault_read`, `vault_write`,
  `vault_append`) — `--mcp-config` on Claude Code/Gemini, config overrides on
  Codex/OpenCode. Writes are frontmatter-validated and safe under concurrency.

Every write auto-commits to the vault's git repo, attributed to the writer —
`agent/<id> (<session>)` for an agent run, `mission-control` for MC itself —
so git history is the audit log of who wrote what. A run of the same project
outside Mission Control sees none of this: access exists only where MC
granted it, and nothing is ever written into your projects' own files.

### Vault page

The **Vault** page (sidebar) is the human window onto all of this — three
panes plus search:

- **Tree** — every note in the vault grouped by folder (`notes/`,
  `_catalog/`, `_mc/`), with an amber ⚑ on notes flagged `needs-review`
  (the header button filters the tree down to them). Search the vault
  full-text from the box at the top; results carry a snippet.
- **Note** — frontmatter as chips (type, project, tags, author, updated)
  above a rendered view. ✎ Edit opens the raw text — frontmatter included,
  validated exactly like an agent's `vault_write`; + New note creates one
  (bare names land in `notes/`). ⚑ Flag / ✓ Clear toggles a note's
  `needs-review` state.
- **Write activity** — the feed of every write (who / what / when, newest
  first), taken from the vault's git log: agent writes land here too,
  wherever they came from. `▤` shows the commit's diff; `↩` reverts that
  single write with one click — a new commit restores the previous content,
  history keeps both, and a conflicting revert (a later write hit the same
  lines) is refused with the reason rather than half-applied. Writes into
  the reserved `_catalog/` / `_mc/` folders carry a ⚑ reserved marker.

The page polls while it's open, so writes made by running agents appear on
their own. When the vault is disabled, the page says so and can enable it.

## How the Claude Code agent works

Each chat message spawns `claude -p <message> --output-format stream-json`,
resuming the previous session ID so the conversation is continuous. The default
permission mode is **Accept edits**; switch to **Bypass permissions** in the
Control Room if you want it to run shell commands autonomously (understand the
risk first — it will act without asking).

## Claude Code as a harness for other models

Any provider that speaks the Anthropic Messages API (z.ai GLM, Moonshot Kimi,
DeepSeek, a local Ollama, …) can sit behind the `claude` binary. Add a second
`claude-code` entry to `agents.config.js` with two extra fields:

```js
{
  id: 'glm', name: 'GLM 5.3', type: 'claude-code', accent: '#5eb0ff',
  description: 'Claude Code harness on z.ai GLM models',
  env: {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: { file: '~/.config/zai/token' },   // read at spawn time
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'GLM-4.5-Air',
  },
  models: [{ value: 'glm-5.3', label: 'GLM 5.3' }],
}
```

- **`env`** is merged into the spawned CLI's environment. A value of
  `{ file: '~/path' }` is read from disk on every run, so secrets stay out of
  the config file (put the key in a `chmod 600` file). If the file is missing
  or empty the run fails immediately with a clear error in the chat. Env values
  are never sent to the browser — the agent list only shows which keys are set.
- **`models`** replaces the Sonnet/Opus/Haiku choices in the Control Room and
  header dropdown; the value goes to `claude --model`. Map the built-in aliases
  with `ANTHROPIC_DEFAULT_*_MODEL` too, since sub-agents still use them.

- **`pricing`** fixes cost tracking. Claude Code prices every run at Anthropic
  rates whatever the backend, so declare how the provider really bills:
  `{ plan: 'GLM Coding Plan', monthly: 18 }` for a flat subscription (runs
  record $0 and the chat shows the plan name), or
  `{ perMillion: { input, output, cacheRead, cacheWrite } }` in USD per
  million tokens for pay-as-you-go APIs. Give both and runs still bill $0, but
  each result also carries `estimated_cost_usd` — the same tokens at list
  price — and the dashboard shows it as "≈$ list" next to actual spend, so a
  subscription agent's usage is still visible in Analytics. `perMillion` can be
  a map of model name → rate card (plus `default`) for agents that run more
  than one model; it is applied per model from the CLI's `modelUsage`. Stored
  history is re-priced on startup, so a config change applies retroactively.
  The CLI's own estimate is kept on each result as `reported_cost_usd`.

Each such agent gets its own workspace, session history, and settings, so an
Anthropic-backed and a GLM-backed Claude Code can run side by side. Commented
examples for Kimi, DeepSeek and Ollama are in `agents.config.js`.

## Agent types

Four adapters ship in `lib/adapters/`; the "+ New agent" type dropdown is fed
by the registry, and an agent whose CLI isn't installed simply shows offline:

- **Claude Code** — `claude -p` streaming JSON; live token streaming, session
  resume, sub-agent visibility (Task fan-out shows as ⑂ chips while running).
- **Codex CLI** — `codex exec --json` (install: `npm i -g @openai/codex`).
  Sessions resume via `codex exec resume`; sandbox + model in the Control Room.
- **Gemini CLI** — `gemini -p --output-format json` (install:
  `npm i -g @google/gemini-cli`). Stateless per message; approval mode + model
  settings.
- **OpenCode** — `opencode run` (install: see opencode.ai). Continues the
  workspace's previous session via `-c`; free-text `provider/model` setting.

## Adding another agent

1. **Write an adapter** — `lib/adapters/my-agent.js`, extending `BaseAdapter`:
   - `refreshAvailability()` — set state to `online`/`offline`
   - `send(text)` — start work; emit `'event'` objects as things happen and
     call `setState('working')` / `setState('online')` around the run
   - `stop()` — abort the current run
   - `settingsSchema()` — fields to show in the Control Room (optional)

   Emit events with these types and the UI renders them automatically:
   `user_prompt`, `assistant` (Anthropic message shape), `user` (tool results),
   `system`/`init`, `result`, `meta`, `error`.

2. **Register the type** in `lib/adapters/index.js`.

3. **Add a config entry** in `agents.config.js`:

   ```js
   { id: 'my-agent', name: 'My Agent', type: 'my-agent',
     description: 'What it does', accent: '#5eb0ff' }
   ```

4. Restart the server. The agent appears on the dashboard with its own chat,
   workspace, and control room — no frontend changes needed.

## Layout

```
server.js            Express + WebSocket server, JSON API
agents.config.js     Agent registry
lib/agent-manager.js Wires adapters to history + broadcasts
lib/adapters/        One adapter per agent type
lib/vault.js         Fleet vault core (settings, init, read/write, preamble)
lib/vault-mcp.js     Stdio MCP server agents get at spawn
lib/mc-notes.js      Distills ROADMAP.md planning rounds into `_mc/` vault notes
public/              The dashboard UI (vanilla JS, no build step)
workspaces/          One working directory per agent
data/                Chat history + settings (gitignore-able)
../fleet-vault/      The shared vault (own git repo, outside this one)
```
