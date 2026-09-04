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

### M15 — Subscription billing on agent config  ↦ folded into M21, shipped 2026-09-04
- New fields on an agent's config: plan name, cost (amount + currency),
  billing period, and renewal date — entered by the user, one agent at a
  time (no shared/linked subscriptions across agents).
- Cost dashboard (M5) shows the subscription as a real line item next to the
  existing actual/estimated API-cost figures, not just metadata on the card.
- Reminder alert one day before the renewal date, through the existing
  notification channels (Telegram/email).

Shipped as the Billing section of the M21 agent form — see M21's notes for
the field shape, the Analytics line item and the reminder.

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

---

# Direct request — 2026-09-04

Not from a planning interview: the user asked in-session for a way to start
several agents at once — e.g. one Claude Code agent in one workspace and
another in a different workspace, concurrently — and to visualise them running
together. Recorded as M17 to keep the milestone numbering continuous.

### M17 — Fleet launch + run timeline  ↦ retired 2026-09-04, replaced by M18
- Launch N agent/prompt pairs in one action (project, agent type, prompt per
  row). Every row runs concurrently: busy agents are never stolen, so N rows
  always means N agents working at once (up to a 12-row cap).
- Swimlane timeline of runs per agent over a shared window, with live
  in-flight bars, failure marking, and click/hover detail.

Shipped notes: `POST /api/fleet/launch` → `AgentManager.launchFleet(rows)`.
Rows validate (blank prompt / unknown type / unknown project → 400/404) and
claim agents of the right type that are online, idle, and queue-less —
preferring one already on the row's project (`reused`, keeps its session
history), then any project-less one (`repointed` via the normal project
pointer), then any idle one; if none, a dynamic agent is spawned ("\<Project\>
agent" / "Fleet \<Type\> agent"). Runs carry origin kind `fleet`, so the ⁂
chips from M8 label them everywhere. `GET /api/fleet/timeline?window=` pairs
each `user_prompt` with its `result` (error / `is_error` / non-success
subtype → failed), adds the in-flight run from the live run record with the
M8 estimate, clamps the window to 10min–7d, and returns one lane per agent
(running lanes first). `#/fleet` page: composer rows + stat tiles (running
now / agents / runs in window / queued — patched on every refresh, not just
first render), lanes coloured by agent with identity in the labelled gutters
(never colour alone — the chart-bar accents needed darker same-hue twins,
`FLEET_CHART_COLORS`, validated against the dark surface), window selector,
hover tooltip, click-for-detail. Geometry is frozen between refetches
({since, now} captured per fetch) so bars don't crawl; run clocks tick
locally every second; WS events refetch on a 1.5s debounce plus a 5s poll
while anything is in flight. Legend explains treatments, not identity:
solid = complete, red = failed, hatched + pulse = in flight (the hatch keeps
running distinct from complete in screenshots/print/CVD, where the pulse is
lost). Fixes that surfaced en route: the availability probe could land after
a run started and stomp `working` back to `online` — both adapters'
`execFile` callbacks now no-op when `isBusy()`; and agent-status broadcasts
re-rendered whatever page was open, yanking the view off vault/analytics/
alerts to home — `onStatusChanged` now guards with `onOtherPage()`. Ops:
`MC_ROOT` env override gives a fully sandboxed second instance (its own
`data/`, workspaces) — how this was verified end-to-end (34 scratch
assertions on validation, concurrency, all three claim modes, run pairing,
windows, failure pairing, and broadcasts; plus a live 3-row launch on
port 1970 against a stub `claude` exercising reused/repointed/spawned, with
screenshots eyeballed mid-flight and at rest).

---

# Direct request — 2026-09-04 (later the same day)

Not from a planning interview: after using M17 the user said they didn't like
the Fleet page. What they actually wanted was simpler — start a new agent
session from the Agents section of the sidebar, in an expanded menu item, and
be taken straight to that agent's existing dashboard (chat prompt and all).
M17's page, endpoints and timeline were removed rather than left as a second
way in.

### M18 — Sidebar agent launcher  ✅ shipped 2026-09-04
- "+ New agent" at the bottom of the sidebar's Agents list expands in place
  into a launcher: agent type, project (or own workspace), optional name,
  optional first prompt.
- Launch creates the agent, points it at the chosen project, sends the first
  prompt, and routes to `#/agent/<id>` — the existing Control Room with the
  chat composer, so the run is already streaming when the page lands.

Shipped notes: no new server surface — the launcher composes the existing
`POST /api/agents`, `POST /api/agents/:id/project` and `POST /api/agents/:id/chat`
calls, so every existing guard (unknown type, unknown project, busy → queue)
applies unchanged. Removed with M17: `POST /api/fleet/launch`,
`GET /api/fleet/timeline`, `AgentManager.launchFleet/timeline`, the `#/fleet`
route, the `fleet` origin kind and its ⁂ chip, and the timeline CSS. The
launcher is one persistent DOM node re-appended by `renderSidebar` (never
rebuilt), and its field values live in `state.agentLaunch`, so agent
broadcasts re-rendering the sidebar don't eat what's being typed; type and
project persist between launches, name and prompt reset. A blank name derives
from the project ("<Project> agent") or the type ("<Type> agent"), numbered
against the current agent list so repeated launches stay distinguishable. If
the project pointer or the first prompt fails after the agent is created, the
agent still exists and you still land on it — the prompt is kept as that
agent's composer draft so nothing typed is lost. The Agents nav now scrolls
(`#agent-nav` is the flex-1 region) so a long agent list plus the open form
can't push the connection footer off-screen. ⌘/Ctrl+Enter in the prompt
launches; Enter in the name field launches.

---

# Round 5 — planning interview 2026-09-04

## Context from the interview

- M18 exposed a modelling gap: the sidebar mixes two things that the code
  never distinguished. Every launch called the same `POST /api/agents` the old
  modal used, so each launch minted a permanent agent in `data/agents.json`
  with its own workspace and history file, sitting next to the two built-ins
  from `agents.config.js` with nothing but a `dynamic` flag to tell them
  apart. "New agent" launched sessions; nothing in the UI could *register* an
  agent at all (the endpoint only accepted a name and type).
- The user's model, confirmed in the interview: a **registered agent** is a
  definition — name, type, description, models, pricing, env — managed in the
  dashboard. A **launched instance** is an ephemeral artefact: a live CLI
  process of one registered agent working against one project. Any number of
  instances may run per agent, concurrently, each on its own chosen project.
- **History belongs to the project, not the agent.** An instance leaves
  behind a conversation and its costs; those are the project's record of what
  was done to it, not the agent's. The registered agent page carries
  configuration, not chat.
- Secrets stay out of the data dir: env values that are tokens keep the
  `{ file: '~/path' }` form; the UI stores the path, never the token.
- `agents.config.js` is kept as the seed for fresh installs; once seeded the
  UI owns the registry, including the built-ins.
- The two dynamic agents M18 left behind are deleted, not migrated.

## Standing decisions (new)

- **Registered agents are templates.** No chat runs against a registered
  agent directly; the composer only exists on a launched instance. Sending a
  message means launching (or being on) an instance.
- **Instances are closed by hand, never auto-retired.** An idle instance stays
  listed until its close button is used; close is refused while the instance
  is working (409, like retire today). "Active" in the sidebar means "exists",
  not "working" — the status dot carries working/idle.
- **An instance always has a project.** Since history is project-owned, the
  "Own workspace" option from M18 goes away; the launcher requires a project.
  (Assumption from the history decision, not asked explicitly — the
  workspace fallback can return as a pseudo-project if it's missed.)
- **Instances are named "\<Project\> · \<Agent\>"**, with a counter only on
  collision ("Fanfair · GLM 2").
- **Token files, not token values.** Registering or editing env in the UI
  accepts a plain value or a file path; anything that looks like a secret is
  expected to be a path, and the config-file convention is documented on the
  form.

## Milestones (in order)

### M19 — Registered agents vs instances + project-owned history  ✅ shipped 2026-09-04
- Registry: `data/agents.json` becomes the list of *registered agents*,
  seeded once from `agents.config.js` (id-matched so re-seeding never
  duplicates); built-ins lose their special status after seeding. The M18
  leftovers ("Claude Code agent", "Fanfair Platform agent") are dropped along
  with their history files and workspaces.
- Instances: `POST /api/agents/:id/instances { projectId, prompt? }` spawns a
  live adapter for that registered agent (inheriting env/models/pricing),
  pointed at the project, with the vault grant attributed to agent +
  project + conversation. Instances have their own id, status, run record and
  queue — everything an agent entry has today except config and history.
  `DELETE /api/agents/:id/instances/:iid` closes an idle instance; 409 while
  working. Instances are persisted (`data/instances.json`) so a server restart
  brings them back idle with their conversation pointer intact.
- History moves to the project: `data/history-<projectId>.json`, every event
  stamped with `agentId` and `iid` as well as `cid`. The existing per-agent
  history files and the `byProject` session pointers migrate once (the
  `pid` stamp M13 added makes the split mechanical; events with no `pid` are
  dropped with the workspace fallback). Project pages gain a "Conversations"
  view listing every instance conversation that ran against the project
  with agent, model, cost and duration; the Control Room's chat/timeline
  reads from the project history filtered to the instance's conversation.
- Analytics, catalog `lastActivity` and `agents` lists, task cards, and
  notifications re-key from agent history to project history; per-agent
  cost rollups become "per registered agent across projects".

### M20 — Sidebar, launcher and home for the new model  ✅ shipped 2026-09-04 with M19
- Sidebar Agents section lists registered agents; each row expands to show
  its instances nested beneath (status dot, project, queue badge, close ✕
  enabled only when idle). Clicking an instance opens the Control Room for
  that instance; clicking the registered agent opens its config page (M21).
- Launch lives per registered agent: a ▶ on each row expands the M18 form in
  place with the type fixed — project (required), optional first prompt —
  and routes to the new instance's Control Room with the run streaming.
  The shared "+ New agent" at the bottom becomes "+ Register agent" (M21).
- Home page shows both: one card per registered agent with its instances
  grouped inside (status, project, cost); stat tiles count registered agents
  and running instances separately.
- Control Room header names the instance ("Fanfair · GLM"), its agent and its
  project; the project dropdown goes (an instance's project is fixed at
  launch), the model dropdown stays (per instance).

Built notes (M19 + M20 together — M19 alone would have left the UI talking to
endpoints that no longer exist, so the sidebar/home/Control Room moved in the
same change). Server: `AgentManager` now holds `registry` (agents.json),
`instances` (instances.json: id, agentId, projectId, name, cid, sessionId,
skills, per-instance settings, queue) and `histories` (one array per project,
`data/history-<pid>.json`, cap 2000, events stamped `agentId` + `iid` + `cid`
+ `pid`). One *probe* adapter per registered agent does the `--version`
availability check and supplies the settings schema; its result is copied
onto every idle instance, so N instances cost one probe every 20s, not N, and
"CLI went offline" alerts fire once per agent. Instances close by hand only
(`DELETE /api/instances/:iid`, 409 while working); everything that hung off
`/api/agents/:id/…` (chat, stop, queue, skills, settings, files, git, attach,
history, session/history clear) now hangs off `/api/instances/:iid/…`, and
`POST /api/agents/:id/instances { projectId, prompt? }` launches. Registered
agents gained `PUT /api/agents/:id` (name/description/accent/models/pricing/
env, with pricing changes re-pricing stored results) and default settings at
`/api/agents/:id/settings`; instance settings overlay those. Projects gained
`GET /api/projects/:id/conversations` (per-cid rollup: agent, instance,
prompts, runs, failures, cost, duration, models, ACTIVE flag) and
`GET /api/projects/:id/history?cid=`. Board dispatch takes `instanceId` and
refuses cross-project dispatch outright (an instance's project is fixed);
tasks carry `instanceId` + `agentId`. WS: `hello` carries `instances`;
`instances` / `instance_status` / `instance_event` / `instance_partial` /
`history_cleared {iid, pid}` replace the agent-keyed messages. Deviations
from the plan above: (1) `byProject` session pointers were *not* turned into
idle instances — that would have booted with seven "ephemeral" instances
nobody launched; their conversations are in the project histories, and a
fresh launch starts a fresh CLI session. (2) Env/pricing edits reach existing
instances on their *next run* (adapters hold a live reference to the registry
entry), not only new launches — simpler, and the M21 page should say "next
run". (3) The default workspace is gone: cards on the default-workspace board
can't be dispatched (toast says why), and the analytics project list no
longer has a "Default workspace" row. Migration runs once on boot when
`state.json` lacks `_model: 2`: UI-created agents from the old model are
deleted with their history files and `workspaces/<id>` dirs; built-in
history is re-keyed into the project files by its `pid` stamp (pid-less
events dropped), the old per-agent files renamed `*.json.v1`; per-agent
keys leave state.json; `_seeded` records the config ids so a removed
built-in never comes back. UI: sidebar rows are `nav-agent` (fold ▸/▾,
accent swatch, name → `#/agent/<id>`, working/total badge, ▶ launch) with
`nav-instance` rows beneath (dot, project, model-or-task, queue badge, ✕
disabled while working); the launcher is one persistent node re-parented
under whichever agent has it open; "+ Register agent" (name + type) sits at
the bottom; a sidebar re-render is deferred while a sidebar field has focus
so status broadcasts can't steal the caret. Home: agent cards with
`instance-row`s inside, tiles for agents / instances / working / CLI tabs /
instance spend. `#/instance/<iid>` is the Control Room (agent chip, project
chip, per-instance model dropdown, "Close instance" replaces "Retire");
`#/agent/<id>` is a read-only definition page with default settings and its
instances (M21 adds editing); `#/project/<id>[/<cid>]` is the conversations
browser (Mission Control conversations first, then the local Claude Code
sessions from before). Feed rows and board 🗂 buttons open the instance
when it's still open, else the conversation in the project. Verification:
`node` could not be executed in the build session (harness permission
denial for every invocation, including `node --check`), so this landed on
static review only; the live pass (first boot on real data with the
migration, a launch, a run, close, and the conversations page) was done on
the user's own instance on 2026-09-04 and everything worked.

### M21 — Agent config in the dashboard  ✅ shipped 2026-09-04 (with M15 folded in)
- "+ Register agent" opens a form: name, type, description, accent, models
  (value/label rows), pricing (plan/monthly and/or per-million rate card),
  env (key + value-or-file-path rows). Saved to `data/agents.json`;
  `POST /api/agents` accepts the full shape.
- Registered agent page (reached from the sidebar) shows and edits the same
  fields (`PUT /api/agents/:id`), lists its instances across projects with
  costs, and offers Remove — refused (409) while any instance of it exists.
  Built-ins are editable and removable like any other; a removed built-in is
  not re-seeded (the seed records seeded ids in `data/state.json`).
- Env edits apply to the next launch only; running instances keep the env
  they were spawned with, and the page says so.
- (M15, folded in) Billing gains the subscription fields: plan, amount +
  currency, period, renewal date; Analytics lists subscriptions as a line
  item; a reminder fires the day before renewal on Telegram/email.

Shipped notes: one form for both jobs — `openAgentForm(null)` from
"+ Register agent" (sidebar and the home add-card) and `openAgentForm(agent)`
from ✎ Edit on the agent page — as a modal, so the sidebar's focus guard and
the page's re-render on every broadcast never touch what's being typed. The
page itself stays read-only: Definition (type, availability, models,
billing, renewal, env as key = value / 📄 file path / •••••• masked), Default
settings, a new "Spend across projects" block (runs, failures, spend and
list-price estimate from `/api/analytics`, cached 10s because the page
re-renders on every instance status), and the instances list. Sections:
Identity (name, type — disabled while instances exist, the server 409s too —
description, accent colour with the six preset swatches), Models (value /
label rows), Billing (plan, amount, currency, per month/year, renews-on date;
rate card rows model / input / output / cache read / cache write where a
blank model is `default`, a single blank row stores the flat card), and
Environment (variable, Value|File, value-or-path rows with the token-file
convention on the form). Server: `normalizePricing` runs on registry load,
seed, register and edit, so `monthly: 18` from older configs becomes
`amount 18 / USD / month` and junk rates are dropped; `publicAgent` now
exposes `env` for the form, sending `{ secret: true }` in place of any plain
value under a token/key/password-looking name — the form shows a "stored,
leave blank to keep" placeholder and posts the marker back, which
`applyAgentPatch` resolves to the stored value. File-backed entries only ever
hold the path. `agents.config.js` stays the seed and its comments still
document the same shape. Deviation from the plan text: env (and models and
pricing) edits reach running instances on their *next run*, not their next
launch — adapters read the registry entry live — and the form says so.
M15 in practice: `AgentManager.subscriptions()` (plan, amount, currency,
period, renewsOn, daysToRenewal, monthlyEquivalent) rides on `/api/analytics`;
the Analytics page gains a "Subscriptions / month" tile (summed per currency,
yearly plans ÷ 12 — no FX conversion) and a Subscriptions table with the
renewal countdown (amber ≤ 7 days, red overdue). `checkRenewals()` runs 2s
after boot and every 5 minutes: a renewal ≤ 1 day away calls
`notifier.renewalDue`, which sends once per agent per renewal date
(`_state.renewalNotified`) on Telegram and, when email is enabled, as a
mail; the `renewalReminder` event toggle sits on the Alerts page next to the
others. A renewal date that has passed rolls forward one period (day clamped
to the month's length, so the 31st stays month-end) and is saved, so the
reminder recurs without re-entry — an assumption, not from the interview.
Verified on a scratch copy of the data on port 1970: the API round trips
(register with the full shape, edit keeping a masked secret, clearing
pricing, amount without a plan name → "Subscription", remove), 19 scratch
assertions on roll-forward / reminder / dedupe / channels, and a headless
Chrome pass through the edit modal (prefilled rows, save, masked env
placeholder, re-save keeps the secret), the register modal, Analytics and
Alerts with no console errors. The user's own instance and data were not
touched.

Recommended order: M19 first — it is the data model the other two render,
and doing the sidebar against the old model would be thrown away. M20 next so
the change is usable; M21 last since the seed keeps registration working via
the config file until then.

