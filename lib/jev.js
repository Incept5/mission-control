// Jev (typesafe/jev-1.13) — a typed decision model served through OpenRouter's
// Decisions API. Given a drafted prompt and the instance model dropdown's real
// options, it picks the cheapest adequate model and reports a confidence —
// the routing-suggestion badge next to the agent page's model dropdown.
//
// This module owns the routing policy: the criteria below are ours, jev only
// applies them, so the fleet's model menu changes here rather than in the
// model. The wording is what scripts/jev-router-experiment.mjs validated
// against hand labels (10/12 exact, both misses defensible; low-confidence
// picks flip run-to-run, hence the borderline fallback to the sonnet tier).
//
// Billing is input-only (~$0.00003 per call), so rating every drafted prompt
// is effectively free. Everything but malformed input fails soft as
// `unavailable` — a missing key or an OpenRouter outage just hides the badge.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';
// Below this the pick is genuinely unstable (probe: sonnet↔opus flips across
// repeat runs) — recommend the workhorse tier instead and let the human
// decide. High-confidence picks were stable and correct in every probe.
const BORDERLINE_CONFIDENCE = 0.8;
const MAX_OPTIONS = 12;

const TIER_CRITERIA = {
  fable: 'Hardest problems: novel architecture or cross-system design, long-horizon autonomous work, debugging where even the approach is unknown. Reserved for tasks where depth of reasoning is the bottleneck.',
  opus: 'Complex, subtle, or high-stakes: multi-file refactors that must preserve behavior, security review, concurrency, migrations of live data, root-cause debugging with unclear symptoms.',
  sonnet: 'Everyday engineering with clear intent: features in a known pattern, bug fixes with a repro, tests, wiring up config or presets. The capable default when nothing special applies.',
  glm: 'Cheap competent labour: mechanical multi-occurrence edits, boilerplate, doc writing that needs reading code, consistent bulk transformations.',
  haiku: 'Trivial or classification-like: one-line edits, summaries, bullet digests, anything where a mistake is instantly visible.',
};

// Name heuristics map a dropdown value to the tier whose criterion describes
// it. Unknown ids get the sonnet criterion — the conservative "workhorse"
// reading for a model we can't classify, matching the borderline fallback.
function tierOf(value) {
  const v = String(value).toLowerCase();
  if (/fable/.test(v)) return 'fable';
  if (/opus/.test(v)) return 'opus';
  if (/sonnet/.test(v)) return 'sonnet';
  if (/haiku/.test(v)) return 'haiku';
  if (/glm|qwen|deepseek|kimi|grok|gemma|llama/.test(v)) return 'glm';
  return 'sonnet';
}

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const line = fs.readFileSync(path.join(os.homedir(), '.config/openrouter/key'), 'utf8').split('\n')[0].trim();
    if (line) return line;
  } catch { /* no key file */ }
  return null;
}

// prompt: the drafted message text. models: the dropdown's real options
// ([{value,label}]); empty values ("Default (account setting)") are skipped —
// jev chooses among the models the instance could actually run.
async function suggestModel({ prompt, models }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { status: 400 });
  }
  if (prompt.length > 8000) {
    throw Object.assign(new Error('prompt too long (8000 chars max)'), { status: 400 });
  }
  const options = (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.value === 'string' && m.value.trim())
    .slice(0, MAX_OPTIONS)
    .map((m) => ({ value: m.value.trim(), label: String(m.label || m.value) }));
  if (options.length < 2) return { trivial: true };

  const key = readKey();
  if (!key) return { unavailable: 'no OpenRouter key — set OPENROUTER_API_KEY or store one at ~/.config/openrouter/key' };

  // Criteria keyed by the dropdown's own values, each described by its tier's
  // policy text — jev picks a real option, so no result mapping is needed.
  const criteria = {};
  for (const opt of options) criteria[opt.value] = TIER_CRITERIA[tierOf(opt.value)];

  const started = Date.now();
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        state: { task: prompt },
        questions: {
          model: {
            type: 'choice',
            instructions: 'Which model should run this task? Prefer the cheapest model whose worst plausible mistake is still acceptable for this task.',
            criteria,
          },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return { unavailable: `could not reach OpenRouter (${err.message})` };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { unavailable: `OpenRouter answered ${response.status}${body.trim() ? `: ${body.trim().slice(0, 200)}` : ''}` };
  }

  const data = await response.json().catch(() => null);
  const answer = data?.answers?.model;
  const chosen = options.find((o) => o.value === answer?.choice);
  if (!chosen) return { unavailable: 'jev returned no usable choice' };

  // Borderline → recommend the first sonnet-tier option (dropdown order) so
  // the human has a safe default; agents with no sonnet-tier model keep
  // jev's raw pick and the badge says borderline anyway.
  let defaultTo = null;
  let defaultLabel = null;
  if ((answer.confidence ?? 0) < BORDERLINE_CONFIDENCE) {
    const safe = options.find((o) => tierOf(o.value) === 'sonnet');
    if (safe && safe.value !== chosen.value) { defaultTo = safe.value; defaultLabel = safe.label; }
  }

  const probabilities = {};
  for (const [k, v] of Object.entries(answer.probabilities || {})) probabilities[k] = v;
  return {
    model: chosen.value,
    label: chosen.label,
    tier: tierOf(chosen.value),
    confidence: answer.confidence ?? null,
    borderline: (answer.confidence ?? 0) < BORDERLINE_CONFIDENCE,
    defaultTo,
    defaultLabel,
    probabilities,
    cost: data.usage?.cost ?? null,
    ms: Date.now() - started,
  };
}

module.exports = { suggestModel, tierOf };
