/**
 * Tests for the remap-project JSONL atomic-rewrite logic.
 *
 * Exercises the core algorithm in isolation (no Electron IPC, no DB) by
 * re-implementing the loop from the IPC handler against a real temp directory.
 * This keeps tests fast (node:test, no jsdom) and fully deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── helpers ────────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-remap-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Core JSONL rewrite logic extracted from the remap-project IPC handler.
 * Rewrites every cwd occurrence of oldPath → newPath across all .jsonl files
 * in folderPath using atomic tmp+rename writes.
 */
function remapJsonlFolder(folderPath, oldPath, newPath) {
  const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  for (const file of jsonlFiles) {
    const filePath = path.join(folderPath, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const updated = content.split('\n').map(line => {
      if (!line) return line;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd === oldPath) {
          parsed.cwd = newPath;
          return JSON.stringify(parsed);
        }
      } catch {}
      return line;
    }).join('\n');
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, updated);
    fs.renameSync(tmp, filePath);
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

test('rewrites cwd in a single JSONL file', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const line1 = JSON.stringify({ type: 'user', cwd: oldPath, message: 'hello' });
    const line2 = JSON.stringify({ type: 'assistant', cwd: oldPath, message: 'world' });
    fs.writeFileSync(path.join(tmp, 'session.jsonl'), line1 + '\n' + line2 + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    const result = fs.readFileSync(path.join(tmp, 'session.jsonl'), 'utf8');
    const lines = result.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).cwd, newPath);
    assert.equal(JSON.parse(lines[1]).cwd, newPath);
  } finally {
    cleanup(tmp);
  }
});

test('rewrites cwd across multiple JSONL files atomically', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';

    for (let i = 0; i < 3; i++) {
      const line = JSON.stringify({ type: 'user', cwd: oldPath, idx: i });
      fs.writeFileSync(path.join(tmp, `session-${i}.jsonl`), line + '\n');
    }

    remapJsonlFolder(tmp, oldPath, newPath);

    for (let i = 0; i < 3; i++) {
      const content = fs.readFileSync(path.join(tmp, `session-${i}.jsonl`), 'utf8');
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.cwd, newPath, `session-${i}.jsonl should have new cwd`);
      assert.equal(parsed.idx, i, `session-${i}.jsonl should preserve idx`);
    }
  } finally {
    cleanup(tmp);
  }
});

test('preserves lines without cwd field verbatim', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const withCwd = JSON.stringify({ type: 'user', cwd: oldPath });
    const noCwd = JSON.stringify({ type: 'system', text: 'no cwd here' });
    const otherCwd = JSON.stringify({ type: 'user', cwd: '/some/other/path' });

    fs.writeFileSync(
      path.join(tmp, 'mixed.jsonl'),
      [withCwd, noCwd, otherCwd].join('\n') + '\n'
    );

    remapJsonlFolder(tmp, oldPath, newPath);

    const lines = fs.readFileSync(path.join(tmp, 'mixed.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).cwd, newPath);     // updated
    assert.equal(JSON.parse(lines[1]).text, 'no cwd here'); // untouched
    assert.equal(JSON.parse(lines[2]).cwd, '/some/other/path'); // different cwd, untouched
  } finally {
    cleanup(tmp);
  }
});

test('preserves empty lines in JSONL files', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const line = JSON.stringify({ type: 'user', cwd: oldPath });

    // JSONL files often end with a trailing newline, creating an empty last "line"
    fs.writeFileSync(path.join(tmp, 'session.jsonl'), line + '\n\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    const content = fs.readFileSync(path.join(tmp, 'session.jsonl'), 'utf8');
    // The trailing double newline should be preserved as-is
    assert.ok(content.endsWith('\n\n'), 'trailing newlines should be preserved');
  } finally {
    cleanup(tmp);
  }
});

test('atomic write: tmp file is created and then removed by rename', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const line = JSON.stringify({ type: 'user', cwd: oldPath });
    const jsonlPath = path.join(tmp, 'session.jsonl');
    fs.writeFileSync(jsonlPath, line + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    // After rewrite the .tmp file must be gone (renamed into place)
    assert.ok(!fs.existsSync(jsonlPath + '.tmp'), '.tmp file should not exist after rename');
    // And the JSONL should exist with updated content
    assert.ok(fs.existsSync(jsonlPath), 'JSONL file should exist');
    assert.equal(JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim()).cwd, newPath);
  } finally {
    cleanup(tmp);
  }
});

test('lines with invalid JSON are passed through unchanged', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const badLine = '{ not valid json ';
    const goodLine = JSON.stringify({ type: 'user', cwd: oldPath });

    fs.writeFileSync(path.join(tmp, 'session.jsonl'), goodLine + '\n' + badLine + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    const lines = fs.readFileSync(path.join(tmp, 'session.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).cwd, newPath);
    assert.equal(lines[1], badLine, 'invalid JSON line should pass through unchanged');
  } finally {
    cleanup(tmp);
  }
});

test('non-.jsonl files in the folder are ignored', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';

    fs.writeFileSync(path.join(tmp, 'session.jsonl'), JSON.stringify({ cwd: oldPath }) + '\n');
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ cwd: oldPath }));
    fs.writeFileSync(path.join(tmp, 'readme.txt'), 'cwd: ' + oldPath);

    remapJsonlFolder(tmp, oldPath, newPath);

    // Only the .jsonl file should be modified
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8')).cwd,
      oldPath,
      'meta.json should be untouched'
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, 'readme.txt'), 'utf8'),
      'cwd: ' + oldPath,
      'readme.txt should be untouched'
    );
  } finally {
    cleanup(tmp);
  }
});
