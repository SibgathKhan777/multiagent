const fs = require('fs');
const config = require('../config/default');
const { execute, parseJestJson, parseStartupResult, buildDockerArgs } = require('../src/agents/executor');
const { mapFailuresToModules, generateExecutionFeedback } = require('../src/agents/feedback');

const jestJson = (over = {}) => JSON.stringify({
  numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numFailedTestSuites: 1,
  testResults: [{
    name: '/work/tests/auth.test.js', status: 'failed', message: '',
    assertionResults: [
      { status: 'passed', fullName: 'Auth loads', failureMessages: [] },
      { status: 'failed', fullName: 'Auth exports', failureMessages: ['\x1b[31mexpected defined\x1b[0m at /work/src/auth/auth.js:3'] },
    ],
  }],
  ...over,
});

// Scripted fake for the process runner: no Docker needed.
function fakeRunner(script) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = cmd === 'docker' && args[0] === 'info' ? 'info'
      : args.includes('install') ? 'install'
      : args.some((a) => String(a).includes('__STARTUP_RESULT__')) ? 'startup'
      : args.some((a) => String(a).includes('jest')) ? 'test' : 'other';
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1, ...(script[key] || {}) };
  };
  return { runner, calls };
}

const files = [
  { path: 'src/auth/auth.js', content: 'module.exports = {};', module: 'Auth Module' },
  { path: 'tests/auth-module.test.js', content: '//', module: 'Test: Auth Module' },
  { path: 'package.json', content: '{}', module: 'Package' },
];

describe('parseJestJson', () => {
  test('extracts failures, strips ANSI, relativizes paths', () => {
    const r = parseJestJson(jestJson());
    expect(r.total).toBe(2);
    expect(r.passed).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ file: 'tests/auth.test.js', test: 'Auth exports' });
    expect(r.failures[0].message).not.toMatch(/\x1b/);
  });
  test('reports suites that failed to run', () => {
    const r = parseJestJson(JSON.stringify({
      numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numFailedTestSuites: 1,
      testResults: [{ name: '/work/tests/x.test.js', status: 'failed', message: 'Cannot find module', assertionResults: [] }],
    }));
    expect(r.failures[0].test).toMatch(/failed to run/);
  });
  test('returns null for non-jest output', () => {
    expect(parseJestJson('boom')).toBeNull();
    expect(parseJestJson('')).toBeNull();
  });
});

describe('buildDockerArgs', () => {
  const args = buildDockerArgs({ name: 'n', projectDir: '/tmp/p', network: false, readOnlyProject: true, command: ['x'] });
  test('applies isolation flags', () => {
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--read-only', '--pids-limit']));
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('/tmp/p:/work:ro');
    expect(args).toContain('no-new-privileges');
  });
  test('install phase gets network and rw mount', () => {
    const a = buildDockerArgs({ name: 'n', projectDir: '/tmp/p', network: true, readOnlyProject: false, command: ['x'] });
    expect(a[a.indexOf('--network') + 1]).toBe('bridge');
    expect(a).toContain('/tmp/p:/work:rw');
  });
});

describe('execute', () => {
  test('skips (not success) when Docker is unavailable', async () => {
    const { runner, calls } = fakeRunner({ info: { code: 1 } });
    const r = await execute({ files, runner });
    expect(r.skipped).toBe(true);
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(1); // only the docker info probe — nothing was run
  });

  test('rejects path-traversal file lists before running anything', async () => {
    const { runner, calls } = fakeRunner({ info: { code: 0 } });
    const r = await execute({ files: [{ path: '../../evil.js', content: 'x' }, ...files], runner });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatch(/Rejected generated files/);
    expect(calls.filter((c) => c.args.includes('install'))).toHaveLength(0);
  });

  test('fails when npm install exits non-zero', async () => {
    const { runner } = fakeRunner({ install: { code: 1, stderr: 'ERESOLVE' } });
    const r = await execute({ files, runner });
    expect(r.success).toBe(false);
    expect(r.installSuccess).toBe(false);
    expect(r.errors[0]).toMatch(/npm install failed/);
  });

  test('fails with structured failures when tests fail', async () => {
    const { runner } = fakeRunner({ test: { code: 1, stdout: jestJson() } });
    const r = await execute({ files, runner });
    expect(r.success).toBe(false);
    expect(r.tests.failures).toHaveLength(1);
  });

  test('fails when zero tests ran, even with exit code 0', async () => {
    const { runner } = fakeRunner({ test: { code: 0, stdout: jestJson({ numTotalTests: 0, numFailedTestSuites: 0, testResults: [] }) } });
    const r = await execute({ files, runner });
    expect(r.success).toBe(false);
  });

  test('succeeds only when install ok, tests ran and all passed', async () => {
    const out = JSON.stringify({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numFailedTestSuites: 0,
      testResults: [{ name: '/work/tests/a.test.js', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] }] });
    const { runner } = fakeRunner({ test: { code: 0, stdout: out } });
    const r = await execute({ files, runner });
    expect(r.success).toBe(true);
    expect(r.tests.passed).toBe(2);
  });

  test('fails on timeout', async () => {
    const { runner } = fakeRunner({ test: { code: null, timedOut: true } });
    const r = await execute({ files, runner });
    expect(r.success).toBe(false);
    expect(r.errors.join()).toMatch(/timed out/);
  });
});

describe('execution feedback', () => {
  const failure = { file: 'tests/auth-module.test.js', test: 'Auth exports', message: 'boom at src/auth/auth.js:3' };

  test('blames the module owning the failing test file', () => {
    const blame = mapFailuresToModules([failure], files);
    expect([...blame.keys()]).toEqual(['Auth Module']);
  });

  test('also blames source files named in the stack trace, never Package/Entry Point', () => {
    const fs2 = [...files, { path: 'src/services/pay.js', content: '', module: 'Payment Module' }, { path: 'src/index.js', content: '', module: 'Entry Point' }];
    const f = { file: 'tests/auth-module.test.js', test: 't', message: 'at src/services/pay.js:9 and src/index.js:1' };
    const blame = mapFailuresToModules([f], fs2);
    expect([...blame.keys()].sort()).toEqual(['Auth Module', 'Payment Module']);
  });

  test('refined prompt contains the real failure and previous code', async () => {
    const { refinedPrompt } = await generateExecutionFeedback({ failures: [failure], originalPrompt: 'ORIG', code: 'const x = 1;', iteration: 0 });
    expect(refinedPrompt).toContain('ORIG');
    expect(refinedPrompt).toContain('Auth exports');
    expect(refinedPrompt).toContain('boom at src/auth/auth.js:3');
    expect(refinedPrompt).toContain('const x = 1;');
  });
});

const passOut = JSON.stringify({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numFailedTestSuites: 0,
  testResults: [{ name: '/work/tests/a.test.js', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] }] });
const withEntry = [...files, { path: 'src/index.js', content: '//', module: 'Entry Point' }];
const startup = (obj) => ({ stdout: '__STARTUP_RESULT__' + JSON.stringify(obj) + '\n' });

describe('executor: cleanup', () => {
  test('temp project dir is removed after success, failure and rejected input', async () => {
    const dirs = [];
    for (const [script, fl] of [
      [{ test: { code: 0, stdout: passOut } }, files],
      [{ install: { code: 1 } }, files],
      [{}, [{ path: '../x', content: '' }, ...files]],
    ]) {
      const { runner } = fakeRunner(script);
      const r = await execute({ files: fl, runner });
      dirs.push(r.projectDir);
    }
    expect(dirs.every((d) => d && !fs.existsSync(d))).toBe(true);
  });

  test('nothing is created when Docker is unavailable', async () => {
    const { runner } = fakeRunner({ info: { code: 1 } });
    const r = await execute({ files, runner });
    expect(r.projectDir).toBeNull();
  });
});

describe('executor: startup and health check', () => {
  test('healthy app is reported', async () => {
    const { runner } = fakeRunner({ test: { code: 0, stdout: passOut }, startup: startup({ started: true, healthOk: true, path: '/api/health', status: 200 }) });
    const r = await execute({ files: withEntry, runner });
    expect(r.success).toBe(true);
    expect(r.startup).toMatchObject({ attempted: true, started: true, healthOk: true });
  });

  test('crashing app is detected; informational by default, gating with requireStartup', async () => {
    const crash = startup({ started: false, healthOk: false, error: 'process exited with code 1 before becoming healthy', output: 'Mongo connect failed' });
    const { runner } = fakeRunner({ test: { code: 0, stdout: passOut }, startup: crash });
    const lenient = await execute({ files: withEntry, runner });
    expect(lenient.startup).toMatchObject({ attempted: true, started: false, healthOk: false });
    expect(lenient.success).toBe(true);

    config.execution.requireStartup = true;
    try {
      const strict = await execute({ files: withEntry, runner });
      expect(strict.success).toBe(false);
    } finally { config.execution.requireStartup = false; }
  });

  test('hung startup probe (timeout) is a failed startup, never a success signal', async () => {
    config.execution.requireStartup = true;
    try {
      const { runner } = fakeRunner({ test: { code: 0, stdout: passOut }, startup: { code: null, timedOut: true, stdout: '' } });
      const r = await execute({ files: withEntry, runner });
      expect(r.startup).toMatchObject({ attempted: true, healthOk: false, error: 'startup probe timed out' });
      expect(r.success).toBe(false);
    } finally { config.execution.requireStartup = false; }
  });

  test('startup probe is skipped when install failed or there is no entry file', async () => {
    const a = await execute({ files: withEntry, runner: fakeRunner({ install: { code: 1 } }).runner });
    expect(a.startup).toBeUndefined();
    const { runner, calls } = fakeRunner({ test: { code: 0, stdout: passOut } });
    const b = await execute({ files, runner });
    expect(b.startup.attempted).toBe(false);
    expect(calls.some((c) => c.args.some((x) => String(x).includes('__STARTUP_RESULT__')))).toBe(false);
  });

  test('parseStartupResult tolerates noise and garbage', () => {
    expect(parseStartupResult('noise\n__STARTUP_RESULT__{"started":true}\n')).toEqual({ started: true });
    expect(parseStartupResult('__STARTUP_RESULT__{oops')).toBeNull();
    expect(parseStartupResult('')).toBeNull();
  });
});

describe('executor: EXEC_SANDBOX=off', () => {
  test('skips without touching Docker or the filesystem', async () => {
    process.env.EXEC_SANDBOX = 'off';
    try {
      const runner = jest.fn();
      const r = await execute({ files, runner });
      expect(r).toMatchObject({ success: false, skipped: true, projectDir: null });
      expect(r.errors[0]).toMatch(/EXEC_SANDBOX=off/);
      expect(runner).not.toHaveBeenCalled();
    } finally { delete process.env.EXEC_SANDBOX; }
  });
});
