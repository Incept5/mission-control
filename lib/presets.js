// Provider presets for the register dialog, keyed by adapter type. The
// claude-code harness can front any provider that speaks the Anthropic
// Messages API — these fill the form so registering one is picking a
// provider and pasting a key, not hand-writing env vars.
//
// Each preset is the same shape the POST /api/agents body accepts:
//   env      values are strings, or `{ file }` for a secret read from disk
//            at spawn time (empty string = the form shows the row, the
//            user fills the path or uses "Save key to file")
//   pricing  subscription and/or rate card, as documented in
//            lib/adapters/claude-code.js
// plus `tokenDir` (where the form's "Save key to file" button writes,
// $HOME/.config/<tokenDir>/token), `note` (shown under Billing, mainly
// to date-stamp the rate card so stale rates get re-checked),
// `discover: 'ollama' | 'litellm' | 'lmstudio'` (the form fetches the model list live
// from the server instead of trusting a hardcoded one — Ollama only
// accepts full name:tag values, and a LiteLLM proxy only the aliases it
// has deployed, so in both cases a bare guess 404s) and
// `pinModelRoles` (the preset fills the ANTHROPIC_DEFAULT_*_MODEL rows
// itself, so discovery curates the tick list without re-choosing them).
//
// Rates checked 2026-09-04. They only feed cost estimates, not invoices —
// when a preset drifts from the provider's page the note is the prompt to
// re-check.
module.exports = {
  'claude-code': [
    {
      id: 'blank',
      label: 'Other (fill in values)',
      blurb: 'Any Anthropic-compatible endpoint — fill in the values yourself',
      name: '',
      description: 'Claude Code harness on an Anthropic-compatible provider',
      env: {
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_AUTH_TOKEN: { file: '' },
        ANTHROPIC_DEFAULT_OPUS_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
      },
      models: [],
      pricing: null,
      note: null,
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      blurb: 'api.deepseek.com · API key, metered',
      name: 'DeepSeek',
      description: 'Claude Code harness on DeepSeek',
      accent: '#4d6bfe',
      tokenDir: 'deepseek',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: { file: '~/.config/deepseek/token' },
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      },
      models: [
        { value: 'deepseek-v4-flash', label: 'V4 Flash' },
        { value: 'deepseek-v4-pro', label: 'V4 Pro' },
      ],
      // API key, no subscription — off-peak rates; weekday peak hours
      // (01:00–04:00 and 06:00–10:00 UTC) are 2×.
      pricing: {
        perMillion: {
          'deepseek-v4-flash': { input: 0.22, output: 0.66, cacheRead: 0.007 },
          'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022 },
          default: { input: 0.22, output: 0.66, cacheRead: 0.007 },
        },
      },
      note: 'API key, metered. Off-peak rates from api-docs.deepseek.com (2026-09-04); weekday peak hours (01–04, 06–10 UTC) are 2×.',
    },
    {
      id: 'kimi',
      label: 'Kimi (Moonshot)',
      blurb: 'api.moonshot.ai · API key, metered',
      name: 'Kimi',
      description: 'Claude Code harness on Moonshot Kimi',
      accent: '#34d399',
      tokenDir: 'kimi',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
        ANTHROPIC_AUTH_TOKEN: { file: '~/.config/kimi/token' },
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.7-code-highspeed',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.6',
      },
      models: [
        { value: 'kimi-k3', label: 'Kimi K3' },
        { value: 'kimi-k2.7-code-highspeed', label: 'K2.7 Code' },
        { value: 'kimi-k2.6', label: 'K2.6' },
      ],
      pricing: {
        perMillion: {
          'kimi-k3': { input: 3, output: 15, cacheRead: 0.3 },
          'kimi-k2.7-code-highspeed': { input: 0.95, output: 4, cacheRead: 0.19 },
          'kimi-k2.6': { input: 0.95, output: 4, cacheRead: 0.16 },
          default: { input: 0.95, output: 4, cacheRead: 0.19 },
        },
      },
      note: 'API key, metered. Rates from platform.kimi.ai (2026-09-04).',
    },
    {
      id: 'zai-glm',
      label: 'z.ai GLM',
      blurb: 'api.z.ai · Coding Plan subscription',
      name: 'GLM 5.3',
      description: 'Claude Code harness on z.ai GLM models',
      accent: '#5eb0ff',
      tokenDir: 'zai',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: { file: '~/.config/zai/token' },
        API_TIMEOUT_MS: '3000000',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
      },
      models: [
        { value: 'glm-5.3', label: 'GLM 5.3' },
        { value: 'glm-5.3-flash', label: 'GLM 5.3 Flash' },
      ],
      // Mirrors the seeded glm agent: plan covers runs, cards give ≈$ list
      // at z.ai pay-as-you-go rates. Lite tier shown; Pro $72, Max $160.
      pricing: {
        plan: 'GLM Coding Plan',
        amount: 18,
        currency: 'USD',
        period: 'month',
        perMillion: {
          'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26 },
          'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03 },
          default: { input: 1.4, output: 4.4, cacheRead: 0.26 },
        },
      },
      note: 'Subscription covers runs; the rate card gives ≈$ list at z.ai pay-as-you-go rates.',
    },
    {
      id: 'spark',
      label: 'Incept5 Spark (LiteLLM)',
      blurb: 'inference.incept5.com · per-user key from the welcome email',
      name: 'Spark Qwen',
      description: 'Claude Code harness on the i5 Spark cluster via its gateway',
      accent: '#f97316',
      tokenDir: 'spark1',
      discover: 'litellm',
      // Discovery curates the tick list; these roles stay put —
      // qwen3.8-27b is the main model, qwen3.6-35b the small/fast one
      // that fields sub-agents and background calls.
      pinModelRoles: true,
      env: {
        // The public gateway fronts the cluster and takes the per-user
        // sk- keys from the welcome email. The tailnet door
        // http://spark1:4000 only accepts the LiteLLM master key —
        // an sk- key sent there fails with "No connected db.".
        ANTHROPIC_BASE_URL: 'https://inference.incept5.com',
        ANTHROPIC_AUTH_TOKEN: { file: '~/.config/spark1/token' },
        // Local GPUs are slower than an API — let long generations breathe.
        API_TIMEOUT_MS: '600000',
        // The DEFAULT_* rows only remap the sonnet/opus/haiku aliases — a
        // user-level model preference in ~/.claude still wins and sends an
        // Anthropic model name the proxy doesn't serve. ANTHROPIC_MODEL
        // pins the selection itself, exactly like the cluster notes' i5c
        // alias does, with the small/fast model in the background role.
        ANTHROPIC_MODEL: 'qwen3.8-27b',
        ANTHROPIC_SMALL_FAST_MODEL: 'qwen3.6-35b',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.6-35b',
        // Open models have a smaller window than Claude Code assumes;
        // the real one keeps compaction firing at the right point.
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '172000',
        // Required: LiteLLM forwards effort as reasoning_effort and
        // qwen3.8-27b accepts low/medium/xhigh — the global xhigh arrives
        // as "high" and is rejected, so medium is pinned per agent.
        CLAUDE_CODE_EFFORT_LEVEL: 'medium',
        // Keep telemetry and update checks off first-party endpoints the
        // proxy can't serve.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      models: [],
      // Self-hosted cluster: no meter behind the proxy, so runs stamp to
      // $0 like the local Ollama preset.
      pricing: { plan: 'Spark cluster (free)' },
      note: 'Self-hosted Qwen on the i5 Spark cluster. Per-user sk- key (welcome email, "Your cluster key") in ~/.config/spark1/token. Model aliases come from the gateway at register time; /v1/models even lists each model\'s accepted reasoning efforts.',
    },
    {
      id: 'ollama-remote',
      label: 'Ollama (another machine)',
      blurb: 'e.g. the Hermes Mac mini · no key needed',
      name: 'Hermes Mac mini (Ollama)',
      description: 'Claude Code harness on an Ollama server elsewhere on the network',
      accent: '#a78bfa',
      discover: 'ollama',
      env: {
        // Edit to the box's LAN name or IP. The server must listen beyond
        // loopback (OLLAMA_HOST=0.0.0.0:11434 on the remote machine).
        ANTHROPIC_BASE_URL: 'http://hermess-mac-mini:11434',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        API_TIMEOUT_MS: '600000',
        ANTHROPIC_DEFAULT_OPUS_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
      },
      models: [],
      pricing: { plan: 'Self-hosted (free)' },
      note: 'Ollama on another machine on the same network — runs cost nothing. Set the base URL to that machine (name or IP, port 11434); it must run with OLLAMA_HOST=0.0.0.0 to accept LAN connections. Model names are read from the server at register time.',
    },
    {
      id: 'inferd-claude',
      label: 'inferd on the Hermes Mac mini',
      blurb: 'Qwen3.8-27B · LiteLLM proxy on port 8301 · key file',
      name: 'Hermes Mac mini (inferd)',
      description: 'Claude Code harness on inferd (Qwen3.8-27B), our Apple Silicon engine',
      accent: '#ec4899',
      tokenDir: 'inferd',
      env: {
        // inferd speaks only the OpenAI API, so a LiteLLM proxy on the mini
        // (~/inference/start-proxy.sh, config ~/inference/litellm.yaml)
        // serves Anthropic /v1/messages in front of it. Both bind the mini's
        // tailnet address; the proxy key is ~/.config/inferd/proxy-key there.
        ANTHROPIC_BASE_URL: 'http://hermess-mac-mini:8301',
        ANTHROPIC_AUTH_TOKEN: { file: '~/.config/inferd/token' },
        API_TIMEOUT_MS: '900000',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.8-27b',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.8-27b',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      models: [{ value: 'qwen3.8-27b', label: 'Qwen3.8-27B (inferd)' }],
      pinModelRoles: true,
      pricing: { plan: 'Self-hosted (free)' },
      note: 'inferd on the Hermes mini through a LiteLLM proxy — runs cost nothing. The proxy pins reasoning effort to medium (Qwen3.8 takes low/medium/xhigh, not Claude Code\'s high). inferd runs a 4 GiB KV pool (~130k tokens) so a 27B can still load in Ollama or LM Studio; one long Claude Code session fits, several will queue. Paste the proxy key (ssh mini cat ~/.config/inferd/proxy-key) with "Save key to file".',
    },
    {
      id: 'lmstudio',
      label: 'LM Studio (local or LAN)',
      blurb: 'port 1234 · no key needed',
      name: 'Hermes Mac mini (LM Studio)',
      description: 'Claude Code harness on an LM Studio server',
      accent: '#38bdf8',
      discover: 'lmstudio',
      env: {
        // Edit to the box's LAN name or IP. In LM Studio's Developer tab,
        // start the server with "Serve on Local Network" enabled.
        ANTHROPIC_BASE_URL: 'http://hermess-mac-mini:1234',
        ANTHROPIC_AUTH_TOKEN: 'lmstudio',
        API_TIMEOUT_MS: '600000',
        ANTHROPIC_DEFAULT_OPUS_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
      },
      models: [],
      pricing: { plan: 'Self-hosted (free)' },
      note: 'LM Studio server (Anthropic-compatible /v1/messages, LM Studio 0.4.1+). For another machine, enable "Serve on Local Network" in its Developer tab and set the base URL to that machine, port 1234. Model ids are read from the server at register time.',
    },
    {
      id: 'ollama',
      label: 'Ollama (local)',
      blurb: 'localhost:11434 · no key needed',
      name: 'Local (Ollama)',
      description: 'Claude Code harness on a local Ollama model',
      accent: '#c084fc',
      discover: 'ollama',
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:11434',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        // Local inference is slower than an API, so let long generations
        // breathe; the model rows are filled in from the discovered list.
        API_TIMEOUT_MS: '600000',
        ANTHROPIC_DEFAULT_OPUS_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
      },
      models: [],
      // Local inference is free, but the CLI still reports a first-party
      // cost — the plan stamps runs to $0 so analytics don't count it.
      pricing: { plan: 'Local (free)' },
      note: 'Local model — runs cost nothing; no key needed. Model names come from the Ollama server at register time (name:tag, as `ollama list` shows).',
    },
  ],
  hermes: [
    {
      id: 'hermes-lan',
      label: 'Hermes (LAN or Tailscale)',
      blurb: 'API server on port 8642 · bearer key',
      name: 'Hermes Mac mini',
      description: 'Hermes agent reached through its API server — a separate session, not the Telegram thread',
      accent: '#f59e0b',
      tokenDir: 'hermes',
      env: {
        // Edit to the Hermes box's LAN or Tailscale name. On that machine set
        // API_SERVER_ENABLED=true, API_SERVER_HOST (LAN/tailnet address,
        // not 0.0.0.0 unless firewalled), API_SERVER_KEY, then restart the gateway.
        HERMES_BASE_URL: 'http://hermess-mac-mini:8642',
        HERMES_API_KEY: { file: '~/.config/hermes/token' },
      },
      models: [],
      pricing: null,
      note: 'Talks to Hermes the way a Telegram message would, through its API server. Each conversation gets its own Hermes session. Use a Tailscale or LAN address only; the key is sent as a bearer token over plain HTTP.',
    },
  ],
  openai: [
    {
      id: 'inferd-hermes',
      label: 'inferd on the Hermes Mac mini',
      blurb: 'Qwen3.8-27B · port 8300 on the tailnet · no key needed',
      name: 'inferd (Hermes mini)',
      description: 'Qwen3.8-27B on inferd, our Apple Silicon engine — chat only, no tools',
      accent: '#f472b6',
      tokenDir: 'inferd',
      env: {
        // inferd's front end binds the mini's tailnet address
        // (~/inference/start-inferd.sh on hermes), so this only resolves on
        // the tailnet. It takes no key.
        OPENAI_BASE_URL: 'http://hermess-mac-mini:8300/v1',
        OPENAI_API_KEY: '',
      },
      models: [{ value: 'qwen3.8-27b', label: 'Qwen3.8-27B (4-bit + DFlash2)' }],
      pricing: { plan: 'Self-hosted (free)' },
      note: 'inferd on the Hermes mini — runs cost nothing. A plain model, not an agent: it answers in the chat but cannot run tools or touch files. Mission Control keeps each conversation and resends it every turn; inferd\'s prefix cache makes follow-ups cheap. Set Thinking to Off for quick answers.',
    },
    {
      id: 'openai-blank',
      label: 'Other OpenAI-compatible server',
      blurb: 'vLLM, llama.cpp, mlx_lm.server… · base URL ends in /v1',
      name: 'OpenAI-compatible model',
      description: 'A model behind an OpenAI-compatible chat completions API',
      accent: '#94a3b8',
      tokenDir: 'openai-compat',
      env: {
        OPENAI_BASE_URL: 'http://localhost:8000/v1',
        OPENAI_API_KEY: '',
      },
      models: [],
      pricing: { plan: 'Self-hosted (free)' },
      note: 'Any server that speaks /v1/chat/completions with streaming. Leave the key empty for self-hosted servers that take none. With no model rows, the first model /v1/models lists is used.',
    },
  ],
  openclaw: [
    {
      id: 'openclaw-lan',
      label: 'OpenClaw (LAN or Tailscale)',
      blurb: 'gateway port 18789 · bearer key',
      name: 'OpenClaw Pi',
      description: 'OpenClaw agent reached through its gateway — a separate session, not the WhatsApp/Telegram threads',
      accent: '#10b981',
      tokenDir: 'openclaw',
      env: {
        // Edit to the box's tailnet name when it runs Tailscale Serve
        // (gateway.tailscale.mode: "serve" proxies the loopback gateway with
        // TLS). On that box: enable
        // gateway.http.endpoints.chatCompletions and set gateway.auth.token,
        // then restart the gateway. A plain LAN http://host:18789 works too
        // when the gateway binds beyond loopback — but the key then travels
        // unencrypted, so prefer the tailnet.
        OPENCLAW_BASE_URL: 'https://ai-server.story-turtle.ts.net',
        OPENCLAW_API_KEY: { file: '~/.config/openclaw/token' },
      },
      models: [],
      pricing: null,
      note: 'Talks to OpenClaw the way a WhatsApp message would, through its gateway\'s OpenAI-compatible chat completions API. Each conversation gets its own session (derived from a per-conversation `user` value). The key is an operator credential — over Tailscale Serve it travels encrypted; on plain LAN HTTP the network is the only protection.',
    },
  ],
};
