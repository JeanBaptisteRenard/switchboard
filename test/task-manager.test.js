const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskManager } = require('../task-manager');

class FakeProcess {
  constructor() {
    this.dataListeners = [];
    this.exitListeners = [];
    this.writes = [];
    this.resizes = [];
  }
  onData(listener) { this.dataListeners.push(listener); }
  onExit(listener) { this.exitListeners.push(listener); }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() { this.exit(0, 15); }
  output(data) { this.dataListeners.forEach(listener => listener(data)); }
  exit(exitCode, signal = 0) { this.exitListeners.forEach(listener => listener({ exitCode, signal })); }
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeManager(tasks) {
  const spawns = [];
  const events = [];
  const manager = createTaskManager({
    pty: {
      spawn(executable, args, options) {
        const process = new FakeProcess();
        spawns.push({ executable, args, options, process });
        return process;
      },
    },
    loadProjectTasks: () => tasks,
    getShellProfile: () => ({ id: 'test', path: '/bin/zsh', args: [] }),
    baseEnv: { PATH: '/usr/bin' },
    send: (...event) => events.push(event),
    log: { info() {}, warn() {}, debug() {} },
  });
  return { manager, spawns, events };
}

test('starts a shell task, retains output, accepts input, and stops it', async () => {
  const task = {
    label: 'dev', type: 'shell', executable: 'npm', args: ['run', 'dev'],
    cwd: process.cwd(), env: {}, useShell: true, dependsOn: [], dependsOrder: 'parallel', supported: true,
  };
  const { manager, spawns } = makeManager([task]);

  const started = manager.startTask('/project', 'dev');
  assert.equal(started.running, true);
  await nextTurn();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].executable, '/bin/zsh');
  assert.match(spawns[0].args.at(-1), /npm 'run' 'dev'/);

  spawns[0].process.output('server ready\r\n');
  manager.sendInput('/project', 'dev', 'r');
  assert.equal(manager.getRun('/project', 'dev').output, 'server ready\r\n');
  assert.deepEqual(spawns[0].process.writes, ['r']);

  assert.deepEqual(manager.stopTask('/project', 'dev'), { ok: true });
  assert.equal(manager.getRun('/project', 'dev').state, 'stopped');
});

test('runs compound dependencies in parallel and combines their logs', async () => {
  const leaf = label => ({
    label, type: 'process', executable: 'node', args: [label], cwd: process.cwd(), env: {},
    useShell: false, dependsOn: [], dependsOrder: 'parallel', supported: true,
  });
  const tasks = [
    leaf('api'), leaf('web'),
    { label: 'all', type: 'compound', dependsOn: ['api', 'web'], dependsOrder: 'parallel', supported: true },
  ];
  const { manager, spawns } = makeManager(tasks);

  manager.startTask('/project', 'all');
  await nextTurn();
  assert.equal(spawns.length, 2);
  spawns[0].process.output('api ready\r\n');
  spawns[1].process.output('web ready\r\n');
  assert.equal(manager.getRun('/project', 'all').output, 'api ready\r\nweb ready\r\n');

  spawns[0].process.exit(0);
  assert.equal(manager.getRun('/project', 'all').state, 'running');
  spawns[1].process.exit(0);
  assert.equal(manager.getRun('/project', 'all').state, 'exited');
});

test('reports unsupported and missing tasks without spawning', () => {
  const { manager, spawns } = makeManager([
    { label: 'docker', type: 'docker-build', supported: false, error: 'not supported', dependsOn: [] },
  ]);
  assert.match(manager.startTask('/project', 'docker').error, /not supported/);
  assert.match(manager.startTask('/project', 'missing').error, /was not found/);
  assert.equal(spawns.length, 0);
});
