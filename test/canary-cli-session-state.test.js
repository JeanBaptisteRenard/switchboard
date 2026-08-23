// test/canary-cli-session-state.test.js — canary over an external dependency.
//
// Convention: a `canary-*.test.js` file asserts nothing about our code. It
// pins an assumption we make about something we do not own, and skips itself
// wherever that thing is absent, so CI and machines without the dependency
// stay green. See .ai/contexts/cli-session-state.md ("Canary tests").
//
// Pinned here: the shape of the Claude CLI's per-session state files in
// ~/.claude/sessions/<pid>.json, which cli-session-state.js reads to rescan a
// session's subagents as soon as its CLI goes idle. The file is not a
// documented interface; a CLI upgrade may change or remove it. This test going
// red means the CLI changed, not that Switchboard broke.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KNOWN_STATUSES } = require('../cli-session-state');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const STATE_FILE_RE = /^\d+\.json$/;

function listStateFiles() {
  try {
    return fs.readdirSync(SESSIONS_DIR).filter(n => STATE_FILE_RE.test(n));
  } catch {
    return [];
  }
}

test('CANARY: the Claude CLI still publishes per-session state we can read', (t) => {
  const files = listStateFiles();
  if (files.length === 0) {
    t.skip(`no ${SESSIONS_DIR}/<pid>.json on this machine — nothing to pin`);
    return;
  }

  const expected = [...KNOWN_STATUSES].join(', ');
  let checked = 0;

  for (const name of files) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
    } catch {
      // A file caught mid-write is expected and is not the canary's business:
      // cli-session-state.js already treats an unparseable read as "do nothing".
      continue;
    }
    checked++;
    const seen = `(${name}, CLI version ${raw.version || 'unknown'})`;

    assert.equal(typeof raw.sessionId, 'string',
      `PINNED ASSUMPTION BROKEN: ~/.claude/sessions/<pid>.json used to carry a string "sessionId" — that field is how cli-session-state.js matches a CLI process to a Switchboard session ${seen}`);
    assert.ok(Number.isInteger(raw.pid),
      `PINNED ASSUMPTION BROKEN: "pid" used to be an integer — cli-session-state.js probes it to reject state left by a dead CLI ${seen}`);
    assert.ok(Number.isInteger(raw.statusUpdatedAt),
      `PINNED ASSUMPTION BROKEN: "statusUpdatedAt" used to be an integer epoch — it is the only evidence that "status" is written on change rather than on a heartbeat ${seen}`);
    assert.ok(KNOWN_STATUSES.has(raw.status),
      `PINNED ASSUMPTION BROKEN: "status" was one of {${expected}}, got ${JSON.stringify(raw.status)} — cli-session-state.js rescans on "idle" only, so a renamed or added status makes the early rescan silently stop firing ${seen}`);
  }

  if (checked === 0) {
    t.skip('every state file was mid-write — nothing to pin this run');
  }
});
