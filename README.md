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
- **Per-agent Workspace** — browse, view, create, and edit files in the agent's
  working directory (`workspaces/<agent-id>/`). The agent runs with this
  directory as its cwd, so anything it builds shows up here.
- **Per-agent Control Room** — model & permission-mode settings, session info,
  abort / new session / clear history, and a raw telemetry event stream.

## Chat features

- **Live streaming** — assistant text streams word-by-word (▊ cursor) and is
  replaced by the final message when the turn completes.
- **Attachments** — paste, drag-drop, or 📎 files/images into the composer
  (20MB max each). They're saved under `.attachments/` in the agent's current
  workspace and the message tells the agent to read them for context.
- **Prompt library** — ☰ in the composer lists saved prompts (global or scoped
  to the agent's current project) and inserts them; "Manage prompts…" adds,
  edits, and deletes (stored in `data/prompts.json`).
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
- The Workspace tab browses the project root.
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

## How the Claude Code agent works

Each chat message spawns `claude -p <message> --output-format stream-json`,
resuming the previous session ID so the conversation is continuous. The default
permission mode is **Accept edits**; switch to **Bypass permissions** in the
Control Room if you want it to run shell commands autonomously (understand the
risk first — it will act without asking).

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
public/              The dashboard UI (vanilla JS, no build step)
workspaces/          One working directory per agent
data/                Chat history + settings (gitignore-able)
```
