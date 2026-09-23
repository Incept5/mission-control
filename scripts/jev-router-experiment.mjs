#!/usr/bin/env node
// Experiment: can typesafe/jev-1.13 (OpenRouter Decisions API) pick the right
// model for a task? Runs a labelled set of mission-control-shaped prompts
// through a `choice` (model) + `score` (complexity) + `noul` (risk) request
// each, then reports agreement with our own expected labels and total cost.
//
// Usage:
//   node scripts/jev-router-experiment.mjs            # live run
//   node scripts/jev-router-experiment.mjs --dry-run  # print one request body, no calls
//
// Key: OPENROUTER_API_KEY env var, or first line of ~/.config/openrouter/key
// (same file convention as the wizard's 🔑 flow). Never printed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';

// The routing policy lives here, not in jev — it just applies it.
const MODEL_CRITERIA = {
  fable: 'Hardest problems: novel architecture or cross-system design, long-horizon autonomous work, debugging where even the approach is unknown. Reserved for tasks where depth of reasoning is the bottleneck.',
  opus: 'Complex, subtle, or high-stakes: multi-file refactors that must preserve behavior, security review, concurrency, migrations of live data, root-cause debugging with unclear symptoms.',
  sonnet: 'Everyday engineering with clear intent: features in a known pattern, bug fixes with a repro, tests, wiring up config or presets. The capable default when nothing special applies.',
  glm: 'Cheap competent labour: mechanical multi-occurrence edits, boilerplate, doc writing that needs reading code, consistent bulk transformations.',
  haiku: 'Trivial or classification-like: one-line edits, summaries, bullet digests, anything where a mistake is instantly visible.',
};

const QUESTIONS = {
  model: {
    type: 'choice',
    instructions:
      'Which model should run this task? Prefer the cheapest model whose worst plausible mistake is still acceptable for this task.',
    criteria: MODEL_CRITERIA,
  },
  complexity: {
    type: 'score',
    instructions: 'How complex is the work itself, ignoring who does it?',
    criteria: [
      'Mechanical — the transformation is fully specified; no choices to make',
      'Local — one file or one concern, clear spec or repro',
      'Structural — several files or constraints; design choices inside a known pattern',
      'Novel — architecture, cross-cutting design, or unknown root cause',
    ],
  },
  risk: {
    type: 'noul',
    instructions: 'Is this task high-stakes?',
    criteria: {
      true: 'Mistakes would be costly or hard to reverse: production data, security, subtle behaviour changes that could ship silently.',
      false: 'Failures are cheap and quickly caught: tests, review, type errors, docs, scratch work.',
    },
  },
};

// Expected = our own routing call, made before looking at jev's answer.
const PROJECT = 'mission-control — local Node.js/Express dashboard for driving AI agent CLIs, vanilla-JS frontend, no build step';
const TASKS = [
  { id: 'rename', expected: 'glm',
    task: 'Rename the renderAgentPage function to renderInstancePage everywhere it is used.' },
  { id: 'readme-node', expected: 'haiku',
    task: "Update the README's install section to mention Node 18+ is required." },
  { id: 'jsdoc', expected: 'glm',
    task: 'Write JSDoc comments for the exported functions in lib/presets.js.' },
  { id: 'dupe-models', expected: 'sonnet',
    task: 'Bug: the model dropdown shows duplicate options when discovery re-fires after saving the key a second time. Repro: register a spark agent, save the key twice, open the Models step.' },
  { id: 'spawn-test', expected: 'sonnet',
    task: 'Add a smoke test that spawns a stub claude CLI and asserts the chosen model lands in its argv.' },
  { id: 'queue-refactor', expected: 'opus',
    task: 'Refactor the 1900-line agent-manager.js run queue into its own module without changing behaviour.' },
  { id: 'routing-schema', expected: 'opus',
    task: 'Design the schema for storing per-task model routing decisions and write the migration for the data directory.' },
  { id: 'multiuser-adr', expected: 'fable',
    task: 'Draft the architecture for a multi-user mode: authentication, per-user agent registries, workspace isolation. Write an ADR.' },
  { id: 'disk-hunt', expected: 'opus',
    task: 'Something is filling the disk under workspaces/. Investigate and find the root cause; du output and recent instance logs are attached.' },
  { id: 'round7-summary', expected: 'haiku',
    task: 'Summarise what changed in ROADMAP.md round 7 in three bullets for the weekly note.' },
  { id: 'openrouter-preset', expected: 'sonnet',
    task: "Add an OpenRouter preset to lib/presets.js following the spark preset's shape." },
  { id: 'auth-review', expected: 'opus',
    task: 'Review this auth token flow for security issues before we ship it; the diff is attached.' },
];

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const line = readFileSync(join(homedir(), '.config/openrouter/key'), 'utf8').split('\n')[0].trim();
    if (line) return line;
  } catch { /* no file */ }
  console.error('No OpenRouter key. Set OPENROUTER_API_KEY or put it in ~/.config/openrouter/key');
  process.exit(1);
}

async function decide(key, task) {
  const body = {
    model: MODEL,
    state: { project: PROJECT, task: task.task },
    questions: QUESTIONS,
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const pad = (s, n) => String(s).padEnd(n);

function report(results) {
  console.log(`\n${pad('task', 18)}${pad('jev→model', 12)}${pad('conf', 6)}${pad('cx', 4)}${pad('risk', 6)}${pad('expected', 10)}ok`);
  for (const r of results) {
    const m = r.answers.model;
    console.log(
      `${pad(r.task.id, 18)}${pad(m.choice, 12)}${pad(m.confidence?.toFixed(2) ?? '-', 6)}` +
      `${pad(r.answers.complexity.score.toFixed(1), 4)}${pad(r.answers.risk.noul >= 0.5, 6)}` +
      `${pad(r.task.expected, 10)}${m.choice === r.task.expected ? '✓' : '✗'}`
    );
  }
  const agree = results.filter((r) => r.answers.model.choice === r.task.expected).length;
  const cost = results.reduce((s, r) => s + (r.usage.cost ?? 0), 0);
  const tokens = results.reduce((s, r) => s + r.usage.input_tokens, 0);
  console.log(`\n${agree}/${results.length} agree with our labels · $${cost.toFixed(6)} total · ${tokens} input tokens`);
  console.log('\nNear-misses (top-2 probabilities):');
  for (const r of results) {
    const p = r.answers.model.probabilities ?? {};
    const top = Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ');
    console.log(`  ${pad(r.task.id, 18)}${top}`);
  }
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ model: MODEL, state: { project: PROJECT, task: TASKS[0].task }, questions: QUESTIONS }, null, 2));
    return;
  }
  const key = apiKey();
  const results = [];
  for (const task of TASKS) {
    const t0 = Date.now();
    try {
      const out = await decide(key, task);
      results.push({ task, ...out });
      console.error(`  ${task.id}: ${out.answers.model.choice} (${Date.now() - t0}ms, $${(out.usage.cost ?? 0).toFixed(7)})`);
    } catch (err) {
      console.error(`  ${task.id}: FAILED ${err.message}`);
    }
  }
  if (results.length) report(results);
}

main();
