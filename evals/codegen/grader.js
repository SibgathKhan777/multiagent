'use strict';

/**
 * Executable grading of a generated function against HIDDEN test cases.
 *
 *  - 'docker' mode  (required for anything an LLM wrote): runs in a throw-away container,
 *    no network, read-only mount, non-root, resource limits, hard timeout.
 *  - 'local-trusted' mode: child process on the host. ONLY for our own reference/mock
 *    fixtures in deterministic CI runs. Never use it for model output.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runProcess, buildDockerArgs, dockerAvailable } = require('../../src/agents/executor');

const MARKER = '__GRADE__';
const timeoutMs = () => parseInt(process.env.EVAL_GRADE_TIMEOUT_MS, 10) || 15000;

// Runs next to solution.js and tests.json (paths are __dirname-relative so both modes work)
const GRADER_SCRIPT = `
'use strict';
const fs = require('fs'), path = require('path'), util = require('util');
const { tests, exportName } = JSON.parse(fs.readFileSync(path.join(__dirname, 'tests.json'), 'utf8'));
const out = (o) => { process.stdout.write('${MARKER}' + JSON.stringify(o) + '\\n'); process.exit(0); };
const norm = (v) => (v === undefined ? '__undefined__' : JSON.parse(JSON.stringify(v)));
let mod;
try { mod = require(path.join(__dirname, 'solution.js')); }
catch (e) { out({ status: e instanceof SyntaxError ? 'syntax_error' : 'load_error', message: String(e && e.message).slice(0, 300) }); }
const fn = typeof mod === 'function' && !mod[exportName] ? mod : mod && mod[exportName];
if (typeof fn !== 'function') out({ status: 'missing_export', message: 'module.exports.' + exportName + ' is ' + typeof fn });
(async () => {
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    try {
      const got = await fn(...JSON.parse(JSON.stringify(t.args)));
      if (t.throws) results.push({ index: i, pass: false, kind: 'expected_throw', got: norm(got) });
      else if (util.isDeepStrictEqual(norm(got), norm(t.expect))) results.push({ index: i, pass: true });
      else results.push({ index: i, pass: false, kind: 'wrong_answer', got: norm(got) });
    } catch (e) {
      if (t.throws) results.push({ index: i, pass: true });
      else results.push({ index: i, pass: false, kind: 'runtime_error', error: String(e && e.message).slice(0, 200) });
    }
  }
  out({ status: 'ran', results });
})().catch((e) => out({ status: 'load_error', message: String(e && e.message).slice(0, 300) }));
`;

function classifyRun(task, raw) {
  const total = task.tests.length;
  if (raw.status !== 'ran') {
    return { executed: true, status: raw.status, passedTests: 0, totalTests: total, failureClass: raw.status, message: raw.message, failures: [] };
  }
  const failures = raw.results.filter((r) => !r.pass).map((r) => ({
    index: r.index,
    args: task.tests[r.index].args,
    expected: task.tests[r.index].throws ? '(throws)' : task.tests[r.index].expect,
    got: r.got, kind: r.kind, error: r.error,
  }));
  const passed = total - failures.length;
  let failureClass = null;
  if (failures.length) failureClass = failures.some((f) => f.kind === 'wrong_answer' || f.kind === 'expected_throw') ? 'wrong_answer' : 'runtime_error';
  return { executed: true, status: failures.length ? 'failed' : 'passed', passedTests: passed, totalTests: total, failureClass, failures };
}

async function gradeSolution(task, code, { mode = 'docker', runner = runProcess } = {}) {
  const total = task.tests.length;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-grade-'));
  try {
    fs.writeFileSync(path.join(dir, 'solution.js'), code);
    fs.writeFileSync(path.join(dir, 'tests.json'), JSON.stringify({ tests: task.tests, exportName: task.export }));
    fs.writeFileSync(path.join(dir, 'grader.js'), GRADER_SCRIPT);

    let stdout; let timedOut = false;
    if (mode === 'local-trusted') {
      const r = spawnSync(process.execPath, [path.join(dir, 'grader.js')], { encoding: 'utf8', timeout: timeoutMs(), cwd: dir });
      stdout = r.stdout || '';
      timedOut = r.error && r.error.code === 'ETIMEDOUT';
    } else if (mode === 'docker') {
      if (!(await dockerAvailable(runner))) {
        return { executed: false, status: 'sandbox_unavailable', passedTests: 0, totalTests: total, failureClass: 'sandbox_unavailable', failures: [] };
      }
      const name = `ai-factory-grade-${crypto.randomBytes(6).toString('hex')}`;
      const res = await runner('docker', buildDockerArgs({ name, projectDir: dir, network: false, readOnlyProject: true, command: ['node', '/work/grader.js'] }), {
        timeoutMs: timeoutMs() + 10000, maxOutputBytes: 256 * 1024,
        onTimeout: () => runner('docker', ['rm', '-f', name], { timeoutMs: 15000, maxOutputBytes: 4096 }),
      });
      stdout = res.stdout || ''; timedOut = res.timedOut;
    } else {
      throw new Error(`Unknown grading mode: ${mode}`);
    }

    if (timedOut) return { executed: true, status: 'timeout', passedTests: 0, totalTests: total, failureClass: 'timeout', failures: [] };
    const line = stdout.split('\n').find((l) => l.startsWith(MARKER));
    if (!line) return { executed: true, status: 'load_error', passedTests: 0, totalTests: total, failureClass: 'load_error', message: 'grader produced no result (process crashed or exited early)', failures: [] };
    return classifyRun(task, JSON.parse(line.slice(MARKER.length)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { gradeSolution, classifyRun, GRADER_SCRIPT };
