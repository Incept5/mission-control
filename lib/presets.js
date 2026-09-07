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
// $HOME/.config/<tokenDir>/token) and `note` (shown under Billing, mainly
// to date-stamp the rate card so stale rates get re-checked).
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
      id: 'ollama',
      label: 'Ollama (local)',
      blurb: 'localhost:11434 · no key needed',
      name: 'Local (Ollama)',
      description: 'Claude Code harness on a local Ollama model',
      accent: '#c084fc',
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:11434',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
      },
      models: [
        { value: 'qwen3-coder', label: 'Qwen3 Coder' },
      ],
      pricing: null,
      note: 'Local model — runs cost nothing; no key needed.',
    },
  ],
};
