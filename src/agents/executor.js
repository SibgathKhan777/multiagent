const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../../config/default');
const { writeFilesSafely, UnsafePathError } = require('../utils/safePath');
const logger = require('../utils/logger').forAgent('Executor');
const tracer = require('../observability/tracer');

/**
 * Executor Agent — Sandboxed Test Execution
 *
 * Generated code is untrusted. It is written under a private temp dir (paths
 * validated first), then installed and tested inside throw-away Docker
 * containers. It is NEVER run on the host: if Docker is unavailable the
 * result is `skipped`, not `success`.
 *
 *   install phase: network on,  npm --ignore-scripts, project dir read-write
 *   test phase:    network OFF, project dir read-only, jest --json
 *
 * Both phases: non-root user, all capabilities dropped, read-only root fs,
 * memory/CPU/pids limits, hard timeout (container is force-removed on timeout).
 *
 * Input:  { files: { path, content }[], projectName?: string }
 * Output: { success, skipped, installSuccess, filesWritten, tests, phases, logs, errors, projectDir }
 *   tests: { ran, total, passed, failed, failures: [{ file, test, message }] }
 *   success is true ONLY if install exited 0 and at least one test ran and none failed.
 */

const CONTAINER_WORKDIR = '/work';

// ─── Startup / health probe (runs INSIDE the container) ───────────────────

const STARTUP_PORT = 9999;
const HEALTH_PATHS = ['/api/health', '/health', '/'];

/**
 * Node script executed in the container: spawn the generated app, poll health
 * endpoints on loopback (works with --network none), report, then kill it.
 */
const STARTUP_PROBE = `
const { spawn } = require('child_process');
const http = require('http');
const entry = process.argv[1], port = ${STARTUP_PORT}, paths = ${JSON.stringify(HEALTH_PATHS)}, deadline = Date.now() + parseInt(process.argv[2], 10);
const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', exited = null;
child.stdout.on('data', d => { out = (out + d).slice(-1500); });
child.stderr.on('data', d => { out = (out + d).slice(-1500); });
child.on('exit', (code, sig) => { exited = { code, sig }; });
const get = (p) => new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000 }, x => { x.resume(); res(x.statusCode); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); });
(async () => {
  let result = null;
  while (Date.now() < deadline && !result) {
    if (exited) { result = { started: false, healthOk: false, error: 'process exited with code ' + exited.code + ' before becoming healthy' }; break; }
    for (const p of paths) { const code = await get(p); if (code) { result = { started: true, healthOk: code >= 200 && code < 400, path: p, status: code }; break; } }
    if (!result) await new Promise(r => setTimeout(r, 300));
  }
  if (!result) result = { started: false, healthOk: false, error: 'no HTTP response before timeout' };
  result.output = out;
  child.kill('SIGKILL');
  process.stdout.write('__STARTUP_RESULT__' + JSON.stringify(result) + '\\n');
  process.exit(0);
})();
`;

function parseStartupResult(stdout) {
  const line = (stdout || '').split('\n').reverse().find((l) => l.startsWith('__STARTUP_RESULT__'));
  if (!line) return null;
  try { return JSON.parse(line.slice('__STARTUP_RESULT__'.length)); } catch { return null; }
}

// ─── Process helper ────────────────────────────────────────────────────────

/**
 * Run a command without a shell. Resolves (never rejects) with exit info and
 * size-capped output. `onTimeout` is called to clean up after a kill.
 */
function runProcess(cmd, args, { timeoutMs, maxOutputBytes, onTimeout } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, signal: null, stdout, stderr: err.message, timedOut, truncated, durationMs: 0, spawnError: err });
    }

    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) { truncated = true; return current; }
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', (c) => { stdout = append(stdout, c); });
    child.stderr.on('data', (c) => { stderr = append(stderr, c); });

    const timer = timeoutMs && setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      if (onTimeout) Promise.resolve(onTimeout()).catch(() => {});
    }, timeoutMs);

    const finish = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, truncated, durationMs: Date.now() - started, spawnError });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ─── Docker helpers ────────────────────────────────────────────────────────

async function dockerAvailable(runner) {
  const res = await runner('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10000, maxOutputBytes: 4096 });
  return res.code === 0 && !res.spawnError;
}

/**
 * Build the `docker run` argument list for one sandboxed phase.
 */
function buildDockerArgs({ name, projectDir, network, readOnlyProject, command }) {
  const ex = config.execution;
  const args = [
    'run', '--rm', '--name', name,
    '--memory', ex.memory, '--memory-swap', ex.memory,
    '--cpus', String(ex.cpus),
    '--pids-limit', String(ex.pidsLimit),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,size=256m',
    '--network', network ? 'bridge' : 'none',
    '-v', `${projectDir}:${CONTAINER_WORKDIR}:${readOnlyProject ? 'ro' : 'rw'}`,
    '-w', CONTAINER_WORKDIR,
    '-e', 'HOME=/tmp',
    '-e', 'npm_config_cache=/tmp/.npm',
    '-e', 'CI=true',
    '-e', 'NODE_ENV=test',
    '-e', 'JWT_SECRET=test-secret-for-execution',
    '-e', 'PORT=9999',
  ];
  if (typeof process.getuid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  }
  args.push(ex.image, ...command);
  return args;
}

// ─── Jest output parsing ───────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;

function toRelative(name) {
  const prefix = CONTAINER_WORKDIR + '/';
  return typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Parse `jest --json` stdout into a compact summary. Returns null if the
 * output isn't jest JSON (e.g. jest crashed before reporting).
 */
function parseJestJson(stdout) {
  if (!stdout) return null;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { data = JSON.parse(stdout.slice(start, end + 1)); } catch { return null; }
  }
  if (!data || !Array.isArray(data.testResults)) return null;

  const failures = [];
  for (const suite of data.testResults) {
    const file = toRelative(suite.name);
    const failedAssertions = (suite.assertionResults || []).filter((a) => a.status === 'failed');
    for (const a of failedAssertions) {
      failures.push({
        file,
        test: a.fullName || a.title,
        message: (a.failureMessages || []).join('\n').replace(ANSI, '').slice(0, 1500),
      });
    }
    // Suite failed without a failing assertion = it could not run (syntax/require error)
    if (suite.status === 'failed' && failedAssertions.length === 0) {
      failures.push({
        file,
        test: '(test suite failed to run)',
        message: String(suite.message || '').replace(ANSI, '').slice(0, 1500),
      });
    }
  }

  return {
    ran: true,
    total: data.numTotalTests || 0,
    passed: data.numPassedTests || 0,
    failed: failures.length,
    failedSuites: data.numFailedTestSuites || 0,
    failures,
  };
}

// ─── Main entry ────────────────────────────────────────────────────────────

/**
 * @param {Object} params
 * @param {Array}  params.files
 * @param {Function} [params.runner] injectable process runner (tests)
 */
async function execute({ files, runner = runProcess } = {}) {
  const ex = config.execution;
  const result = {
    success: false,
    skipped: false,
    projectDir: null,
    filesWritten: 0,
    installSuccess: false,
    phases: {},
    tests: { ran: false, total: 0, passed: 0, failed: 0, failures: [] },
    logs: [],
    errors: [],
  };

  // ─── 0. Sandbox must exist (and be enabled), otherwise do nothing ──────
  if (process.env.EXEC_SANDBOX === 'off') {
    result.skipped = true;
    result.errors.push('Sandboxed execution is disabled (EXEC_SANDBOX=off) — generated code was NOT executed');
    result.logs.push('⚠️ Execution skipped: disabled by configuration');
    return result;
  }
  if (!(await dockerAvailable(runner))) {
    result.skipped = true;
    result.errors.push('Docker is not available — generated code was NOT executed (refusing to run it on the host)');
    result.logs.push('⚠️ Execution skipped: Docker daemon unreachable');
    logger.warn('Docker unavailable — skipping sandboxed execution');
    return result;
  }

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-'));
  result.projectDir = projectDir;

  try {
    // ─── 1. Write files (all paths validated first) ───────────────────
    try {
      result.filesWritten = writeFilesSafely(projectDir, files, { maxFiles: ex.maxFiles, maxFileBytes: ex.maxFileBytes });
    } catch (err) {
      if (err instanceof UnsafePathError) {
        result.errors.push(`Rejected generated files: ${err.message}`);
        logger.warn(`Rejected generated files: ${err.message}`);
        return result;
      }
      throw err;
    }
    result.logs.push(`✅ Wrote ${result.filesWritten} files`);

    if (!files.some((f) => f.path === 'package.json')) {
      result.errors.push('No package.json in generated project');
      return result;
    }

    const runPhase = async (label, { network, readOnlyProject, command, timeoutMs }) => {
      const name = `ai-factory-${label}-${crypto.randomBytes(6).toString('hex')}`;
      const res = await tracer.span(`sandbox.${label}`, { metadata: { network, timeoutMs } }, async (h) => {
        const r = await runner('docker', buildDockerArgs({ name, projectDir, network, readOnlyProject, command }), {
          timeoutMs,
          maxOutputBytes: ex.maxOutputBytes,
          onTimeout: () => runner('docker', ['rm', '-f', name], { timeoutMs: 15000, maxOutputBytes: 4096 }),
        });
        h.setMetadata({ exitCode: r.code, timedOut: r.timedOut });
        return r;
      });
      result.phases[label] = {
        exitCode: res.code, timedOut: res.timedOut, durationMs: res.durationMs,
        stderr: res.stderr.replace(ANSI, '').slice(-2000),
      };
      return res;
    };

    // ─── 2. Install (network on, lifecycle scripts disabled) ──────────
    logger.info('Installing dependencies in sandbox');
    const install = await runPhase('install', {
      network: true,
      readOnlyProject: false,
      timeoutMs: ex.installTimeoutMs,
      command: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'],
    });
    result.installSuccess = install.code === 0;
    if (!result.installSuccess) {
      const why = install.timedOut ? 'timed out' : `exit code ${install.code}`;
      result.errors.push(`npm install failed (${why}): ${(install.stderr || install.stdout).replace(ANSI, '').slice(-500)}`);
      result.logs.push('❌ npm install failed');
      return result;
    }
    result.logs.push('✅ npm install succeeded');

    // ─── 3. Tests (no network, project mounted read-only) ─────────────
    logger.info('Running generated tests in sandbox');
    const test = await runPhase('test', {
      network: false,
      readOnlyProject: true,
      timeoutMs: ex.testTimeoutMs,
      command: ['node_modules/.bin/jest', '--ci', '--json', '--runInBand', '--forceExit'],
    });

    const parsed = parseJestJson(test.stdout);
    if (test.timedOut) {
      result.errors.push(`Tests timed out after ${ex.testTimeoutMs}ms`);
    } else if (!parsed) {
      result.errors.push(`Jest produced no readable report (exit ${test.code}): ${test.stderr.replace(ANSI, '').slice(-500)}`);
    } else {
      result.tests = { ...parsed, failed: parsed.failures.length };
      if (parsed.total === 0) result.errors.push('No tests were executed');
      if (parsed.failures.length > 0) result.errors.push(`${parsed.failures.length} test failure(s)`);
    }

    // ─── 4. Startup + health probe (loopback only, network disabled) ───
    const entry = ['src/index.js', 'index.js', 'server.js', 'app.js'].find((c) => files.some((f) => f.path === c));
    result.startup = { attempted: false, started: false, healthOk: false };
    if (entry && result.installSuccess && !test.timedOut) {
      const probe = await runPhase('startup', {
        network: false,
        readOnlyProject: true,
        timeoutMs: ex.startupTimeoutMs + 15000,
        command: ['node', '-e', STARTUP_PROBE, entry, String(ex.startupTimeoutMs)],
      });
      const parsed = parseStartupResult(probe.stdout);
      result.startup = parsed
        ? { attempted: true, ...parsed, output: String(parsed.output || '').replace(ANSI, '').slice(-600) }
        : { attempted: true, started: false, healthOk: false, error: probe.timedOut ? 'startup probe timed out' : 'no probe result' };
      result.logs.push(result.startup.healthOk ? `✅ App started and answered ${result.startup.path}` : `⚠️ App did not become healthy: ${result.startup.error || 'unhealthy response'}`);
    }

    result.success = result.installSuccess
      && test.code === 0
      && !test.timedOut
      && result.tests.ran
      && result.tests.total > 0
      && result.tests.failed === 0
      && (!ex.requireStartup || result.startup.healthOk);

    result.logs.push(result.success
      ? `✅ ${result.tests.passed}/${result.tests.total} tests passed`
      : `❌ Tests failed: ${result.tests.failed} failure(s), ${result.tests.total} total`);
  } catch (err) {
    result.errors.push(`Execution error: ${err.message}`);
    logger.error(`Execution failed: ${err.message}`);
  } finally {
    if (!ex.keepWorkdir) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }

  logger.info(`Execution complete: success=${result.success}, install=${result.installSuccess}, tests=${result.tests.passed}/${result.tests.total}`);
  return result;
}

module.exports = { execute, parseJestJson, parseStartupResult, buildDockerArgs, runProcess, dockerAvailable, STARTUP_PROBE };
