// Three-state sidebar vocabulary — see docs/subagents.md "Live status".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const BLUE = '#4fc3f7';
const VIOLET = '#8088ff';

function projectWithLiveSubagent() {
  return makeSampleProject({
    sessions: [
      {
        sessionId: 's-top-1',
        name: 'main session',
        summary: 'top level 1',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      },
      {
        sessionId: 'sub:s-top-1:agent-1',
        parentSessionId: 's-top-1',
        agentId: 'agent-1',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: '2026-05-22T09:59:00.000Z',
        messageCount: 1,
      },
    ],
  });
}

// --- the two classes must coexist on the item, or the CSS has nothing to arbitrate

test('a busy session with no subagents carries cli-busy alone', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.sessionBusyState.set('s-top-1', true);
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);

    const parent = ctx.document.getElementById('si-s-top-1');
    assert.ok(parent.classList.contains('cli-busy'), 'cli-busy set from sessionBusyState');
    assert.ok(!parent.classList.contains('has-busy-agents'), 'no subagent indicator without a live subagent');
  } finally {
    ctx.destroy();
  }
});

test('a busy session with live subagents carries cli-busy AND has-busy-agents at once', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.sessionBusyState.set('s-top-1', true);
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const parent = ctx.document.getElementById('si-s-top-1');
    assert.ok(parent.classList.contains('cli-busy'), 'cli-busy is not dropped by the subagent indicator');
    assert.ok(parent.classList.contains('has-busy-agents'), 'has-busy-agents is applied even while busy');

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);
    const reRendered = ctx.document.getElementById('si-s-top-1');
    assert.ok(reRendered.classList.contains('cli-busy'), 'both classes survive a full re-render');
    assert.ok(reRendered.classList.contains('has-busy-agents'), 'both classes survive a full re-render');
  } finally {
    ctx.destroy();
  }
});

// --- source-level pins: jsdom does not resolve ::before, so the cascade is pinned here

test('style.css: cli-busy alone paints the spinner blue', () => {
  const rule = CSS.match(/\.session-item\.cli-busy:not\(\.needs-attention\) \.session-status-dot::before \{[\s\S]*?\}/);
  assert.ok(rule, 'the cli-busy spinner rule must still exist');
  assert.match(rule[0], new RegExp('color:\\s*' + BLUE), 'the plain busy spinner stays light blue');
  assert.match(rule[0], /animation:\s*braille-spin/, 'the spinner animation is the existing one');
});

test('style.css: cli-busy + has-busy-agents tints the same spinner violet', () => {
  const rule = CSS.match(/\.session-item\.cli-busy\.has-busy-agents:not\(\.needs-attention\) \.session-status-dot::before \{[\s\S]*?\}/);
  assert.ok(rule, 'a rule must tint the busy spinner when subagents are live');
  assert.match(rule[0], new RegExp('color:\\s*' + VIOLET), 'it reuses the has-busy-agents violet');
  assert.ok(!/content\s*:/.test(rule[0]), 'the glyph must not change — colour only');
  assert.ok(!/animation\s*:/.test(rule[0]), 'no new animation — docs/decisions/0002');
});

test('style.css: the violet tint wins the cascade over the blue one', () => {
  const blueAt = CSS.indexOf('.session-item.cli-busy:not(.needs-attention) .session-status-dot::before');
  const violetAt = CSS.indexOf('.session-item.cli-busy.has-busy-agents:not(.needs-attention) .session-status-dot::before');
  assert.notEqual(blueAt, -1);
  assert.notEqual(violetAt, -1);
  assert.ok(violetAt > blueAt, 'the tint must come after the rule it overrides');
});

test('style.css: subagents without cli-busy still get the static glyph, unchanged', () => {
  const rule = CSS.match(/\.session-item\.has-busy-agents:not\(\.cli-busy\):not\(\.needs-attention\):not\(\.response-ready\) \.session-status-dot::before \{[\s\S]*?\}/);
  assert.ok(rule, 'the idle-parent indicator must still be keyed on :not(.cli-busy)');
  assert.match(rule[0], /content:\s*"\\283F"/, 'still the static ⠿ cell');
  assert.match(rule[0], new RegExp('color:\\s*' + VIOLET), 'still violet');
  assert.ok(!/animation\s*:/.test(rule[0]), 'still static');
});

test('style.css: needs-attention keeps precedence over the tinted spinner', () => {
  const rule = CSS.match(/\.session-item\.cli-busy\.has-busy-agents:not\(\.needs-attention\) \.session-status-dot::before \{[\s\S]*?\}/);
  assert.ok(rule, 'the tint rule must exist');
  assert.match(rule[0].split('{')[0], /:not\(\.needs-attention\)/,
    'the tint must not paint over the attention indicator');
});

test('the tint can never collide with response-ready: applyActivityClasses keeps them exclusive', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'session-activity.js'), 'utf8');
  assert.match(src, /toggle\('cli-busy',\s*!ready\s*&&/,
    'cli-busy is only ever set when the session is not response-ready');
});
