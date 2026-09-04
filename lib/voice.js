// Voice prompting (M16): transcription backends for the chat composer.
// Audio is recorded in the browser and arrives here as base64 (same transport
// as chat attachments); Whisper is the only server-side backend — the browser's
// built-in dictation never leaves the client.

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

// The Whisper API infers the container from the upload's file extension, so the
// browser's MediaRecorder mime type has to map onto one it accepts.
const EXT_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// POST recorded audio to OpenAI's transcription endpoint. `cfg` is the `_voice`
// settings block ({ whisperKey, whisperModel }); Node 18+'s global fetch,
// FormData and Blob keep it dependency-free like the Telegram calls in notify.
async function whisper(cfg, buffer, mime) {
  const key = String(cfg?.whisperKey || '').trim();
  if (!key) throw httpError(400, 'OpenAI API key is not set — add it from the 🎤 menu in the chat composer');
  const ext = EXT_BY_MIME[String(mime || '').split(';')[0].trim()] || 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/webm' }), `prompt.${ext}`);
  form.append('model', String(cfg.whisperModel || '').trim() || 'whisper-1');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res.status === 401 ? 400 : 502, 'Whisper: ' + (data?.error?.message || res.statusText));
  if (typeof data.text !== 'string') throw httpError(502, 'Whisper: unexpected response (no text field)');
  return { text: data.text.trim(), model: form.get('model') };
}

module.exports = { whisper, EXT_BY_MIME };
