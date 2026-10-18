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

  // ─── 0. Sandbox must exist, otherwise do nothing ──────────────────────
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

    result.success = result.installSuccess
      && test.code === 0
      && !test.timedOut
      && result.tests.ran
      && result.tests.total > 0
      && result.tests.failed === 0;

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

module.exports = { execute, parseJestJson, buildDockerArgs, runProcess };
