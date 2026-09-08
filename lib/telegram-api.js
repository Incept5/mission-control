// Shared Telegram Bot API access. One base URL for both the notifier
// (outbound alerts) and the two-way bot (M10), so verification can point
// everything at a stub server via TELEGRAM_API_BASE instead of the real
// API — two pollers on one real token 409-conflict and steal updates.

const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// POST /bot<token>/<method>; resolves with the API's `result` object.
// A 409 (another getUpdates consumer) carries err.conflict for backoff.
async function tgCall(token, method, body = {}, { signal } = {}) {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = httpError(400, 'Telegram: ' + (data.description || res.statusText));
    if (res.status === 409) err.conflict = true;
    throw err;
  }
  return data.result;
}

module.exports = { API_BASE, tgCall };
