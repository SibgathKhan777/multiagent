'use strict';

/**
 * TEST-ONLY runtime check: runs runtimeCheck.runner.js in a child process on the
 * host so validator tests need no Docker. Only ever pass fixed, trusted snippets
 * from the tests — never generated code. Production uses agents/runtimeCheck.js
 * (Docker).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RUNNER } = require('../../src/agents/runtimeCheck');

async function localRuntimeCheck({ code, moduleName }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-'));
  try {
    const file = path.join(dir, 'module.js');
    fs.writeFileSync(file, code);
    const r = spawnSync(process.execPath, [RUNNER, file, moduleName], { encoding: 'utf8', timeout: 20000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__RUNTIME_RESULT__'));
    if (!line) return { executed: false, reason: 'no result' };
    return { executed: true, ...JSON.parse(line.slice('__RUNTIME_RESULT__'.length)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { localRuntimeCheck };
