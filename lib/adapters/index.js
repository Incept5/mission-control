// Adapter registry: maps agents.config.js `type` -> adapter class.
module.exports = {
  'claude-code': require('./claude-code'),
  'codex': require('./codex'),
  'gemini': require('./gemini'),
  'hermes': require('./hermes'),
  'openclaw': require('./openclaw'),
  'opencode': require('./opencode'),
};
