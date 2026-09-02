# Mission Control — Roadmap

Product decisions from the 2026-09-01 planning interview.

## Standing decisions

- **Permission model**: full autonomy — agents run with bypass/accept modes set
  up front; no interactive mid-run approval UI. Invest elsewhere.
- **Alert channels**: Telegram bot (instant, phone) + email (digests). No Slack.
- **Git depth**: review + commit from the dashboard (diffs, changed files,
  branch, revert). No PR/CI tracking for now.

## Milestones (in order)

### M1 — Multiple agent instances + task queue  ✅ shipped 2026-09-01
- Spawn additional Claude Code agent instances from the UI (no config editing);
  each gets its own sessions, project pointer, workspace, and dashboard card.
- Per-agent task queue: messages sent while busy are queued and run in order
  ("agent is busy" errors disappear). Queue visible/reorderable/cancelable.

### M2 — Git review + commit  ✅ shipped 2026-09-01
- Per-run changed-files list and diff viewer (unified diff per session).
- Commit, branch, and revert actions from the dashboard.
- Workspace tab shows git status of the project root.

### M3 — Kanban task board per project  ✅ shipped 2026-09-01
- Backlog / In progress / Review / Done columns; task cards per project.
- Drag a card onto an agent (or pick from a menu) to dispatch it — it enters
  that agent's queue; card links to the session that did the work.

### M4 — Notifications  ✅ shipped 2026-09-01 (needs user credentials to activate)
- Telegram bot: run complete, run failed/stuck, cost threshold crossed.
- Email digests (daily summary of sessions, costs, outcomes).

### M5 — Analytics & visibility  ✅ shipped 2026-09-01
- Cost & token dashboards per agent/project/day with budget warnings.
- Global activity feed across all agents (runs, errors, file changes, commits).
- Run outcomes & durations (success rates, flaky/expensive task spotting).
- Project health rollup (last activity, open tasks, recent sessions, git state).

### M6 — Chat upgrades  ✅ shipped 2026-09-01
- Attach/paste files and images into chat as agent context.
- Live token streaming (word-by-word via `--include-partial-messages`).
- Prompt library: saved prompts + per-project templates from the composer.
- Session export to Markdown/HTML.

### M7 — More agent types  ✅ shipped 2026-09-01
- Adapters: Codex CLI, Gemini CLI, OpenCode (Aider skipped for now). Verified
  against stub CLIs; agents show offline until the real CLI is installed.
- Sub-agent visibility: Claude Code's Task fan-out shows as live chips under
  the working bar and a ⑂ count on dashboard cards.

**Round 1 complete.** Round 2 below.

---

# Round 2 — planning interview 2026-09-02

## Context from the interview

- Usage pattern: up to 3 agents concurrently, each on its own project. The
  user does other work while runs execute — fleet-level visibility and
  away-from-keyboard control matter more than watching a single stream.
- Single-agent dispatch is enough; no agent-to-agent chains or planner agents.
- Board stays, but its long-term use is uncertain — don't build on top of it.
- Not wanted right now: scheduling/triggers, hard cost controls, review
  workflow changes (approve/request-changes), PR/CI tracking.
- Bug report that started this round: managed runs are hidden from the
  "Live CLI sessions" panel by design (they're agent cards). What was actually
  missing is *where a run came from* — see M8.

## Standing decisions (new)

- **Run origin lives on agent cards**, not in the Live CLI panel. The Live CLI
  panel remains external-tabs-only.
- **Duration estimates are informational only** — no alerts or escalation
  when a run overshoots.
- **Remote access is Telegram-first.** Two-way bot replaces a tunnel/login for
  now; a phone-friendly web UI behind Tailscale is a later option.
- **Memory boundary**: mission control keeps its *own* memory (only what ran
  through the mission-control project). It knows about every registered
  project's harness files, but projects never learn anything about mission
  control — nothing is written into a project on its behalf.
- **Obsidian vault**: not yet created; designed in a separate session. M11's
  memory store must be a plain Markdown folder so a vault can adopt it later.

## Milestones (in order)

### M8 — Run origin + duration estimate on agent cards  ✅ shipped 2026-09-02
- Every run records its origin (`chat`, `board` + card title, or `queue` with
  what fed it) on its `user_prompt` history event and in live status
  (`status.run`). Shown on dashboard cards, the agent header, working bar,
  chat prompts, session list/detail, queue items, activity feed, and the
  Markdown export.
- Live elapsed/estimate clock on the working card and header. Baseline =
  median duration of this agent's past successful runs on the same project
  (falling back to the agent, then the fleet; needs 2 samples per tier),
  refined after 3+ tool calls by projecting against the typical tool-call
  count. Shows "~N left" and flips to "N over". Nothing else reacts to it.

### M9 — Project harness browser
- Per registered project, a "Harness" view listing every AI-harness file:
  `CLAUDE.md`, `AGENTS.md`, `.claude/` (settings, skills, agents, commands),
  the native memory folder under `~/.claude/projects/<encoded>/memory/`,
  and any `docs/wiki` or `.ai/`-style folder the user adds to a detection
  list. Browse and edit in place (reuses the Workspace editor).
- Project cards show a summary chip (e.g. "CLAUDE.md · 3 skills · 12 memories").

### M10 — Two-way Telegram
- Inbound bot commands: `/status` (fleet), `/agents`, `/agent <id>` (current
  run, queue, last reply), `/send <id> <text>` (queue a prompt), `/stop <id>`,
  `/last <id>` (last assistant reply), `/diff <id>` (changed files summary).
- Replying to a run-complete / run-failed alert routes the text to that agent
  as the next prompt — no command syntax needed.
- Review from the phone: the run-complete alert includes changed files; a
  `/commit <id> <msg>` command commits from the workspace.
- Single allowed chat ID (already captured by "Detect"); everything else is
  ignored. Long-polling `getUpdates` from the server, no webhook/tunnel.

### M11 — Mission control memory
- A Markdown memory folder (`data/memory/`) owned by mission control: one file
  per fact/decision, an index file, plain frontmatter — the same shape as
  Claude Code's memory so a future Obsidian vault can point at it directly.
- Scope: only runs and interviews conducted *in the mission-control project*.
  Registered projects are indexed (name, path, harness summary from M9) so
  mission control can reason about them, but nothing is written back to them.
- Dashboard page to browse/edit memories; agents running with mission-control
  as their project get the folder loaded as context.
- Vault integration (daily notes, run summaries into the vault) deferred to the
  vault design session.
