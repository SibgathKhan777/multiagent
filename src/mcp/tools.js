'use strict';

/**
 * Tool implementations behind the MCP server. Plain async functions so they
 * can be unit-tested without the protocol. Each returns JSON-serializable data
 * or throws an Error (reported to the caller as an MCP tool error).
 */

const fs = require('fs');
const path = require('path');
const { resolveSafe, UnsafePathError } = require('../utils/safePath');

const MAX_READ_BYTES = 200 * 1024;
const MAX_LIST_ENTRIES = 500;

function requireWorkspace(workspace) {
  if (!workspace) throw new Error('No workspace configured (set MCP_WORKSPACE)');
  return fs.realpathSync(workspace);
}

/** Resolve a user-supplied path inside the workspace, following symlinks safely. */
function resolveInWorkspace(workspace, rel) {
  const root = requireWorkspace(workspace);
  const target = resolveSafe(root, rel);
  const real = fs.realpathSync(target); // throws ENOENT if missing
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new UnsafePathError(`Path resolves outside the workspace: ${rel}`);
  }
  return real;
}

async function validateCode({ code, moduleName, requirements }) {
  const { validate } = require('../agents/validator');
  const r = await validate({ code, moduleName, requirements: requirements || '' });
  return { score: r.score, passed: r.passed, issues: r.issues };
}

async function runUnitTests({ files }) {
  const { execute } = require('../agents/executor');
  const r = await execute({ files });
  return {
    success: r.success,
    skipped: r.skipped,
    installSuccess: r.installSuccess,
    tests: { total: r.tests.total, passed: r.tests.passed, failed: r.tests.failed, failures: r.tests.failures },
    errors: r.errors,
  };
}

async function listProjectFiles({ dir } = {}, { workspace }) {
  // models routinely send "" or "." for "no value": both mean the workspace root
  const atRoot = dir === undefined || dir === null || dir === '' || dir === '.';
  const start = atRoot ? requireWorkspace(workspace) : resolveInWorkspace(workspace, dir);
  const root = requireWorkspace(workspace);
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow links while walking
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(start);
  return { files: out.sort(), truncated: out.length >= MAX_LIST_ENTRIES };
}

async function readProjectFile({ path: rel }, { workspace }) {
  const real = resolveInWorkspace(workspace, rel);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
  if (stat.size > MAX_READ_BYTES) throw new Error(`File too large (${stat.size} bytes, max ${MAX_READ_BYTES})`);
  return { path: rel, content: fs.readFileSync(real, 'utf8') };
}

module.exports = { validateCode, runUnitTests, listProjectFiles, readProjectFile, MAX_READ_BYTES };
