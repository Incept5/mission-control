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

### M11 — Mission control memory  ↦ superseded by Round 3 (M12–M14)
- Designed as a deliberate placeholder for the fleet vault ("plain Markdown so
  a future Obsidian vault can point at it directly"). Never shipped: the
  Round 3 vault subsumes it — one memory system, with mission control's own
  notes living in the vault's reserved `_mc/` namespace instead of
  `data/memory/`.

---

# Round 3 — planning interview 2026-09-03

Shared fleet memory: an Obsidian vault every registered agent can query and
write, so each agent knows what projects exist, how they're set up in
mission control, and how its own work fits the whole.

## Context from the interview

- The Round 2 asymmetry stands: projects never learn about mission control.
  MC grants vault access at spawn (context preamble + MCP config) and never
  edits a project's own files to do it. A run of the same project outside MC
  sees nothing.
- Audience is agents only — the user inspects through the dashboard, not by
  keeping personal notes in the vault.
- Agent writes go live immediately; no review queue. Git history and the
  write activity feed are the safety nets.
- Access is hybrid: a short spawn preamble (catalog + fit + instructions) so
  every run starts knowing the fleet, plus pull-on-demand MCP tools for
  everything else.

## Standing decisions (new)

- **One memory system (option c)**: the vault subsumes M11. Reserved
  namespaces `_catalog/` (auto-maintained project pages) and `_mc/`
  (mission control's own distilled decisions); agents read everything and
  write anywhere. Edits to reserved folders are flagged in the activity
  feed, never blocked.
- **Vault location**: a sibling directory outside the MC repo, path
  configured per machine in `data/settings.json` — so any MC user can point
  at their own personal vault. It is its own git repo (it can't live under
  `data/`, which is gitignored) and MC auto-commits every write, attributed
  to the writer (agent + session, or `mission-control`).
- **Telemetry stays out of the vault**: sessions, costs, run history remain
  in `data/*.json`. No auto-written run summaries; catalog pages carry only a
  last-activity stamp.
- **Retirement over deletion**: unregistering a project marks its catalog
  page `status: retired`; its notes stay. Staleness handling is just an
  agent-settable `needs-review` flag surfaced on the Vault page.

## Milestones (in order)

### M12 — Vault core + MCP server  ✅ shipped 2026-09-03
- `lib/vault.js`: resolve the vault path from settings, initialize it (git
  repo + `_catalog/`, `_mc/`, `notes/`), validated read/write helpers, index
  builder, auto-commit per write.
- `lib/vault-mcp.js`: stateless stdio MCP server, spawned per agent through
  each adapter's MCP flag (`--mcp-config` for Claude Code, the equivalents
  for Codex / Gemini / OpenCode). Tools: `vault_search` (full text + tag /
  type / project filters), `vault_read`, `vault_write` (frontmatter
  validated), `vault_append` (concurrent-write-safe add to an existing note).
- Frontmatter on every note: `type` (project-note | convention | decision |
  gotcha | how-to), `project` (slug, omitted when cross-project), `tags`,
  `author`, `updated`. Notes sit flat in `notes/`; folder structure can be
  introduced later if drift demands it.
- Spawn preamble, capped and rebuilt on every vault write: the catalog index
  (project, path, one-liner, stack tags, status), the current project's own
  catalog page, and three lines of usage instruction — search before
  assuming, write durable learnings, append rather than duplicate.
- Shipped notes: vault path lives under the reserved `_vault` key in
  `data/settings.json` (default sibling `../fleet-vault`), with
  `GET/PUT /api/vault` to inspect/redirect/disable it. Boot seeds a minimal
  catalog page per registered project so the preamble has an index; M13 owns
  the refresh/retire lifecycle. The Claude Code path (inline `--mcp-config` +
  `--append-system-prompt`) is verified end-to-end against the real CLI;
  the Codex `-c`, Gemini `--mcp-config`, and OpenCode `--config` equivalents
  follow their docs and remain stub-verified until those CLIs are installed.

### M13 — Auto-maintained catalog + `_mc/`  ✅ shipped 2026-09-03
- MC writes and refreshes `_catalog/<slug>.md` per registered project — on
  registration, on harness changes (M9's harness summary once it ships;
  name / path / agents until then), and on run events for the last-activity
  stamp. Unregister sets `status: retired`.
- MC distills its own planning interviews and operating decisions into
  `_mc/` notes (the scope M11 had claimed for `data/memory/`).
- Shipped notes: `Vault#refreshCatalog` regenerates a page from live manager
  data (name / path / summary / agents / registered / last-activity /
  status); refreshes are surgical — frontmatter keys MC doesn't own
  (`stack`, `needs-review`, agent-added fields) and any dated-append
  sections survive, and a refresh that changes nothing skips the write.
  Hooks: registration, project edits, agent reassignment (both pages), every
  finished run (day-granular stamp → at most one write per project per day),
  unregister (`retireCatalog`, page kept), and a boot reconciliation that
  refreshes every page, retires orphans, and re-distills `_mc/`.
  `lib/mc-notes.js` distills ROADMAP.md — one `decision` note per planning
  round (round 1 is the document preamble, dated by its interview line),
  wrapped decision lines folded in — hash-guarded so hand edits survive
  until their round's decisions change. Verified against a scratch vault
  (23 assertions: create/update/idempotence/foreign-key and append
  survival/retire/re-distill) and a live boot (4 catalog refreshes + 3
  `_mc/` notes auto-committed; a second boot writes nothing).

### M14 — Vault page in the dashboard  ✅ shipped 2026-09-03
- File tree over the vault, note viewer/editor, search, and the write
  activity feed (who / what / when) with one-click git revert of a single
  write.
- `needs-review` notes flagged in the list. No per-agent-card vault chips.
- Shipped notes: `#/vault` sidebar page — three panes (tree | note | feed)
  plus full-text search over the tree pane. Tree rows carry type/updated and
  an amber ⚑ per needs-review note (folder headers count theirs; the header
  "⚑ Needs review" button filters to flagged). Viewer shows frontmatter
  chips and a Markdown render (headings/lists/links/fences); the editor
  works on raw text, frontmatter included — the same validation path as an
  agent's `vault_write` — and there's a one-click flag/clear plus new-note
  creation. The feed is the vault's git log: subject parsed into action +
  path + reserved-folder flag + revert detection, `▤` shows the commit
  patch, `↩` runs `git revert --no-edit` under the vault lock (conflicts
  abort cleanly and surface a 409; the revert commits as `mission-control`).
  Routes: `GET /api/vault/notes|note|search|feed|commit`, `PUT /api/vault/note`,
  `POST /api/vault/revert`, guarded by a `requireVault()` disabled/not-ready
  check. Writes from the dashboard poll (20s) — agent writes land via MCP
  processes nothing can push from. Fix that surfaced: bare YAML `true/false`
  in frontmatter now parse as booleans, so a `needs-review: true` written by
  `vault_write` actually round-trips (previously it read back as the string
  "true" and never flagged). Verified: 26 scratch-vault assertions (feed
  parsing incl. reserved/revert rows, revert of update/create, conflicting
  revert 409 + lock released, hash guards, needs-review, search) and the
  full write→flag→revert cycle live against the real vault on a second
  server instance (port 1970).

---

# Round 4 — planning interview 2026-09-03

## Context from the interview

- Prompted by an Anthropic invoice (Max plan - 20x, £150 + VAT = £180/mo,
  billed 1st of the month): agents backed by a flat-rate subscription rather
  than pay-as-you-go API billing have no way to record what that
  subscription actually costs or when it renews. M5's existing
  `estimated_cost_usd` (list-price-if-metered) already covers the "what
  would this have cost" side; this covers the "what am I actually paying"
  side.
- Other Round 4 questions (M9/M10/M13/M14 prioritization, board's fate,
  vault UX beyond M14, adapter usage in practice, sub-agent display, revisiting
  declined items) went unanswered — not wanted right now.

## Milestones (in order)

### M15 — Subscription billing on agent config
- New fields on an agent's config: plan name, cost (amount + currency),
  billing period, and renewal date — entered by the user, one agent at a
  time (no shared/linked subscriptions across agents).
- Cost dashboard (M5) shows the subscription as a real line item next to the
  existing actual/estimated API-cost figures, not just metadata on the card.
- Reminder alert one day before the renewal date, through the existing
  notification channels (Telegram/email).

### M16 — Voice prompting  ✅ shipped 2026-09-04
- Two transcription backends, picked per use: OpenAI Whisper API (needs a
  key), and Claude Code's own built-in voice/dictation for that adapter.
- Not specified in the interview, so defaulting to the pattern M6 already
  uses for other input methods: lands in the chat composer as editable text
  for review before send, not an auto-send; dashboard composer only for now,
  no Telegram voice messages.
- Shipped notes: 🎤 button in the composer opens the per-use picker. Whisper:
  the browser records via MediaRecorder (auto-stops at 2 minutes) and POSTs
  base64 audio to `/api/transcribe`, which calls OpenAI's transcription
  endpoint (Node's global fetch/FormData, no new deps). Built-in dictation:
  the browser's SpeechRecognition streams final + interim text into the
  composer live; if the text changes underneath (typed into, or a send
  cleared it) dictation rebases onto what's there instead of resurrecting
  what it last wrote. One voice session at a time, held in module state so a
  chat re-render doesn't kill it; click the button again to finish, Esc to
  discard. Substitution for "Claude Code's own built-in voice/dictation":
  claude 2.1.260 exposes no headless voice or transcription surface (checked
  `--help` and subcommands — hold-to-talk is interactive-TUI only), so the
  keyless second backend is the browser's built-in dictation, which works for
  every adapter. Whisper settings (`whisperKey`, `whisperModel` — defaults to
  `whisper-1`) live under the reserved `_voice` key in `data/settings.json`
  via `GET/PUT /api/voice`, edited from the picker's settings modal. Verified:
  23 scratch assertions (stubbed-fetch request shape: auth, blob mime,
  extension mapping, error mapping; `_voice` round-trip and persistence) plus
  a scratch instance on port 1970 — routes, guards, and a live OpenAI round
  trip that reached their API and rejected only the deliberately fake key.

