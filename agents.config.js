// Register your agents here. Each entry needs a unique `id`, a `type` that
// matches an adapter in lib/adapters/index.js, and optionally a workspace dir.
//
// To add a new agent:
//   1. Write an adapter in lib/adapters/<type>.js (extend BaseAdapter)
//   2. Register the type in lib/adapters/index.js
//   3. Add an entry below and restart the server
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
  ],
};
