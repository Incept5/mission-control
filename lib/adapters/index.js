// Adapter registry: maps agents.config.js `type` -> adapter class.
module.exports = {
  'claude-code': require('./claude-code'),
  'codex': require('./codex'),
  'gemini': require('./gemini'),
  'opencode': require('./opencode'),
};
