'use strict';

/**
 * Task-aware MCP tools backed by the pipeline's MongoDB records.
 * Read-only except run_project_tests (which executes in the Docker sandbox and
 * therefore requires approval at the server layer).
 *
 * `deps` is injectable so these can be tested without a database.
 */

const mongoose = require('mongoose');
const { resolveSafe } = require('../utils/safePath');

const TASK_ID = /^[0-9a-fA-F-]{8,64}$/;
const MAX_FILE_BYTES = 200 * 1024;

function defaultDeps() {
  return {
    Task: require('../models/Task'),
    Module: require('../models/Module'),
    FeedbackLog: require('../models/FeedbackLog'),
    execute: (args) => require('../agents/executor').execute(args),
    ensureDb,
  };
}

let connecting = null;
/** Connect once, fail fast (never hang a tool call on an unreachable database). */
async function ensureDb() {
  if (mongoose.connection.readyState === 1) return;
  if (!connecting) {
    const config = require('../../config/default');
    connecting = mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: 3000 }).catch((err) => {
      connecting = null;
      throw new Error(`Database unavailable: ${err.message.split('\n')[0]}`);
    });
  }
  await connecting;
}

function checkTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new Error('Invalid taskId');
}

async function loadTask(deps, taskId) {
  checkTaskId(taskId);
  await deps.ensureDb();
  const task = await deps.Task.findOne({ taskId });
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

async function getTaskStatus({ taskId }, deps = defaultDeps()) {
  const task = await loadTask(deps, taskId);
  const modules = await deps.Module.find({ taskId }).sort({ priority: 1 });
  const outcome = task.finalOutput?.outcome || null;
  return {
    taskId,
    idea: task.idea,
    status: task.status,
    error: task.error || null,
    verdict: outcome?.verdict || null,
    reasons: outcome?.reasons || [],
    resumeCount: task.resumeCount || 0,
    metadata: task.metadata || {},
    modules: modules.map((m) => ({
      name: m.name, type: m.type, status: m.status, iteration: m.iteration ?? 0,
      qualityScore: m.qualityScore ?? 0, validationPassed: !!m.validationPassed, usedFallback: !!m.usedFallback,
    })),
    execution: task.finalOutput?.execution
      ? { success: !!task.finalOutput.execution.success, skipped: !!task.finalOutput.execution.skipped, tests: task.finalOutput.execution.tests ? { passed: task.finalOutput.execution.tests.passed, total: task.finalOutput.execution.tests.total } : null }
      : null,
  };
}

async function getValidationReport({ taskId, moduleName }, deps = defaultDeps()) {
  await loadTask(deps, taskId);
  const mods = await deps.Module.find({ taskId }).sort({ priority: 1 });
  const selected = moduleName ? mods.filter((m) => m.name === moduleName) : mods;
  if (moduleName && !selected.length) throw new Error(`Module not found: ${moduleName}`);

  const logs = await deps.FeedbackLog.find({ taskId });
  return {
    taskId,
    modules: selected.map((m) => {
      const history = logs.filter((l) => l.moduleId === m.moduleId).sort((a, b) => a.iteration - b.iteration);
      return {
        name: m.name,
        validationPassed: !!m.validationPassed,
        usedFallback: !!m.usedFallback,
        finalScore: m.qualityScore ?? 0,
        iterations: (m.iteration ?? 0) + 1,
        feedbackRounds: history.map((l) => ({ iteration: l.iteration, previousScore: l.previousScore, issues: (l.issues || []).map((i) => ({ type: i.type, message: i.message, severity: i.severity })) })),
      };
    }),
  };
}

async function inspectProjectFiles({ taskId, path: rel }, deps = defaultDeps()) {
  const task = await loadTask(deps, taskId);
  const files = task.finalOutput?.files;
  if (!Array.isArray(files)) throw new Error('This task has no generated files yet');
  if (!rel) return { taskId, files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content || '', 'utf8'), module: f.module })) };

  resolveSafe('/virtual-root', rel); // same path rules as everywhere else: no traversal, absolute, backslash...
  const file = files.find((f) => f.path === rel);
  if (!file) throw new Error(`File not found in generated project: ${rel}`);
  if (Buffer.byteLength(file.content || '', 'utf8') > MAX_FILE_BYTES) throw new Error('File too large to display');
  return { taskId, path: rel, content: file.content };
}

async function runProjectTests({ taskId }, deps = defaultDeps()) {
  const task = await loadTask(deps, taskId);
  const files = task.finalOutput?.files;
  if (!Array.isArray(files) || !files.length) throw new Error('This task has no generated files to test');
  const r = await deps.execute({ files: files.map(({ path, content }) => ({ path, content })) });
  return {
    taskId, success: r.success, skipped: !!r.skipped, installSuccess: !!r.installSuccess,
    tests: { total: r.tests.total, passed: r.tests.passed, failed: r.tests.failed, failures: r.tests.failures },
    startup: r.startup || null, errors: r.errors,
  };
}

module.exports = { getTaskStatus, getValidationReport, inspectProjectFiles, runProjectTests, ensureDb };
