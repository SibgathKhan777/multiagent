'use strict';

/**
 * Runtime check of a generated module, executed INSIDE a Docker container.
 *
 * The module is loaded with stubbed dependencies and its exports are
 * test-called by runtimeCheck.runner.js. Generated code never runs in the host
 * process: Node's vm is not a security boundary. If Docker is unavailable (or
 * VALIDATOR_RUNTIME=off) the check is skipped and reported as such.
 *
 * @returns {Promise<{executed: boolean, reason?: string, loaded?: boolean, ...}>}
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProcess, buildDockerArgs, dockerAvailable } = require('./executor');
const logger = require('../utils/logger').forAgent('RuntimeCheck');

const RUNNER = path.join(__dirname, 'runtimeCheck.runner.js');
const MARKER = '__RUNTIME_RESULT__';
const TIMEOUT_MS = 30000;
const MAX_CODE_BYTES = 512 * 1024;

let availability = { at: 0, ok: false };
async function dockerOk(runner) {
  if (Date.now() - availability.at > 30000) {
    availability = { at: Date.now(), ok: await dockerAvailable(runner) };
  }
  return availability.ok;
}

function resetAvailabilityCache() { availability = { at: 0, ok: false }; }

async function runtimeCheck({ code, moduleName }, { runner = runProcess } = {}) {
  if (process.env.VALIDATOR_RUNTIME === 'off') return { executed: false, reason: 'disabled (VALIDATOR_RUNTIME=off)' };
  if (typeof code !== 'string' || Buffer.byteLength(code) > MAX_CODE_BYTES) return { executed: false, reason: 'code missing or too large' };
  if (!(await dockerOk(runner))) return { executed: false, reason: 'Docker unavailable — generated code is never run on the host' };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-rt-'));
  const name = `ai-factory-rt-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(path.join(dir, 'module.js'), code, { mode: 0o644 });
    fs.copyFileSync(RUNNER, path.join(dir, 'runner.js'));

    const res = await runner('docker', buildDockerArgs({
      name,
      projectDir: dir,
      network: false,
      readOnlyProject: true,
      command: ['node', '/work/runner.js', '/work/module.js', String(moduleName || 'module').replace(/[^\w .-]/g, '_').slice(0, 80)],
    }), {
      timeoutMs: TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      onTimeout: () => runner('docker', ['rm', '-f', name], { timeoutMs: 15000, maxOutputBytes: 4096 }),
    });

    if (res.timedOut) {
      return { executed: true, loaded: false, loadError: 'Execution timed out in sandbox — possible infinite loop', timeout: true, exportCount: 0, exportNames: [], callResults: [] };
    }
    const line = (res.stdout || '').split('\n').reverse().find((l) => l.startsWith(MARKER));
    if (!line) {
      logger.warn(`Runtime check produced no result (exit ${res.code})`);
      return { executed: false, reason: `sandbox produced no result (exit ${res.code})` };
    }
    try {
      return { executed: true, ...JSON.parse(line.slice(MARKER.length)) };
    } catch {
      return { executed: false, reason: 'sandbox result was not valid JSON' };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runtimeCheck, resetAvailabilityCache, RUNNER };
