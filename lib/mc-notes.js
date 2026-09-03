const crypto = require('crypto');

// Distills Mission Control's own planning record (ROADMAP.md) into `_mc/`
// vault notes (ROADMAP M13): one note per planning round carrying that
// round's standing decisions. Planning is interview-driven and the roadmap
// is its written record, so the roadmap is the source of truth and this
// stays a pure text-in / prepared-notes-out function — the vault writes the
// result hash-guarded (Vault#syncMcNotes), rewriting a note only when its
// round's decisions actually changed.
//
// Roadmap shape: the first interview's decisions live in the document
// preamble (under the title, dated by its "…from the YYYY-MM-DD planning
// interview." line); later rounds get explicit
// "# Round N — planning interview DATE" headings.

const ROUND_RE = /^# Round (\d+)\s+—\s+planning interview\s+(\d{4}-\d{2}-\d{2})/;
const DATE_RE = /from the (\d{4}-\d{2}-\d{2}) planning interview/;

function distillRoadmap(text) {
  const rounds = [];
  let seenTitle = false;
  // The preamble round = the first interview, numbered 1.
  let cur = { round: 1, date: null, decisions: [] };
  let capturing = false;
  const closeRound = () => {
    if (cur && cur.decisions.length) rounds.push(cur);
    cur = null;
    capturing = false;
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const round = line.match(ROUND_RE);
    if (round) {
      closeRound();
      cur = { round: +round[1], date: round[2], decisions: [] };
      continue;
    }
    if (/^# /.test(line)) {
      // The document title opens the implicit first round; any other
      // top-level heading ends the round in progress.
      if (seenTitle) closeRound();
      else seenTitle = true;
      continue;
    }
    if (!cur) continue;
    const dated = line.match(DATE_RE);
    if (dated) cur.date ||= dated[1];
    if (/^## /.test(line)) {
      capturing = /^## Standing decisions/.test(line);
      continue;
    }
    if (capturing) {
      const m = line.match(/^- (.+)$/);
      if (m) {
        cur.decisions.push(m[1].trim());
      } else if (/^\s+\S/.test(line) && cur.decisions.length) {
        // Wrapped continuation of the previous decision — fold it in so a
        // note never ends mid-sentence.
        cur.decisions[cur.decisions.length - 1] += ' ' + line.trim();
      } else if (line) {
        capturing = false; // the list ended
      }
    }
  }
  closeRound();
  return rounds.map(toNote);
}

function toNote({ round, date, decisions }) {
  const hash = crypto
    .createHash('sha1')
    .update(`round ${round}\n${date || ''}\n${decisions.join('\n')}`)
    .digest('hex')
    .slice(0, 12);
  return {
    rel: `_mc/planning-round-${round}.md`,
    hash,
    content: [
      '---',
      'type: decision',
      `tags: [planning, round-${round}]`,
      `round: ${round}`,
      ...(date ? [`date: ${date}`] : []),
      'source: ROADMAP.md',
      `source-hash: ${hash}`,
      '---',
      '',
      `# Planning round ${round}${date ? ` (${date})` : ''} — standing decisions`,
      '',
      ...decisions.map((d) => `- ${d}`),
      '',
      'Standing decisions from Mission Control’s planning interviews; full',
      'context and milestone history live in the roadmap.',
      '',
    ].join('\n'),
  };
}

module.exports = { distillRoadmap };
