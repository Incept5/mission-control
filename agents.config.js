// Register your agents here. Each entry needs a unique `id`, a `type` that
// matches an adapter in lib/adapters/index.js, and optionally a workspace dir.
//
// To add a new agent:
//   1. Write an adapter in lib/adapters/<type>.js (extend BaseAdapter)
//   2. Register the type in lib/adapters/index.js
//   3. Add an entry below and restart the server
//
// Claude Code as a harness for other models
// ------------------------------------------
// The `claude-code` adapter accepts two extra fields, so the same `claude`
// binary can front any provider that speaks the Anthropic Messages API:
//
//   env    Extra environment variables for the spawned CLI. A value may be a
//          string, or `{ file: '~/path' }` to read a secret from disk at spawn
//          time — keep tokens out of this file, it is committed.
//   models Options for the Control Room model dropdown, replacing the built-in
//          Sonnet/Opus/Haiku list. Values are passed to `claude --model`.
//   pricing Claude Code prices runs at Anthropic rates whatever the backend, so
//          tell Mission Control how this provider really bills:
//            { plan: 'GLM Coding Plan', monthly: 18 }   flat fee → runs cost $0
//            { perMillion: { input: 1, output: 3.2, cacheRead: 0.2 } }
//          The CLI's figure is kept on each result as `reported_cost_usd`.
//
// Claude Code still resolves its `sonnet`/`opus`/`haiku` aliases internally
// (e.g. for sub-agents), so map them via ANTHROPIC_DEFAULT_*_MODEL too.
module.exports = {
  agents: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      type: 'claude-code',
      description: "Anthropic's agentic coding CLI",
      accent: '#d97757',
      workspace: 'workspaces/claude-code',
    },
    {
      id: 'glm',
      name: 'GLM 5.3',
      type: 'claude-code',
      description: 'Claude Code harness on z.ai GLM models',
      accent: '#5eb0ff',
      workspace: 'workspaces/glm',
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
      // Coding Plan tiers (z.ai/subscribe): Lite $18, Pro $72, Max $160 a month.
      // Flat fee with a credit quota, so runs have no marginal cost.
      pricing: { plan: 'GLM Coding Plan', monthly: 18 },
    },

    // More providers that work the same way — copy, fill in, restart.
    //
    // Kimi (Moonshot):
    // {
    //   id: 'kimi', name: 'Kimi K2', type: 'claude-code', accent: '#34d399',
    //   description: 'Claude Code harness on Moonshot Kimi',
    //   env: {
    //     ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
    //     ANTHROPIC_AUTH_TOKEN: { file: '~/.config/kimi/token' },
    //     ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2-thinking',
    //     ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2-thinking',
    //     ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2-turbo-preview',
    //   },
    //   models: [{ value: 'kimi-k2-thinking', label: 'Kimi K2 Thinking' }],
    // },
    //
    // DeepSeek:
    // {
    //   id: 'deepseek', name: 'DeepSeek', type: 'claude-code', accent: '#fbbf24',
    //   description: 'Claude Code harness on DeepSeek',
    //   env: {
    //     ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    //     ANTHROPIC_AUTH_TOKEN: { file: '~/.config/deepseek/token' },
    //     ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-chat',
    //     ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-chat',
    //     ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
    //   },
    //   models: [{ value: 'deepseek-chat', label: 'DeepSeek V3' }],
    // },
    //
    // Local model via Ollama (Ollama exposes an Anthropic-compatible endpoint):
    // {
    //   id: 'local', name: 'Local (Ollama)', type: 'claude-code', accent: '#c084fc',
    //   description: 'Claude Code harness on a local Ollama model',
    //   env: {
    //     ANTHROPIC_BASE_URL: 'http://localhost:11434',
    //     ANTHROPIC_AUTH_TOKEN: 'ollama',
    //     ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-coder',
    //     ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder',
    //     ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
    //   },
    //   models: [{ value: 'qwen3-coder', label: 'Qwen3 Coder' }],
    // },
  ],
};
