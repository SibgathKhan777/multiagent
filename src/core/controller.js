const { v4: uuid } = require('uuid');
const { STAGES, PipelineState } = require('./pipeline');
const { decompose } = require('../agents/decomposer');
const { generatePrompt } = require('../agents/promptGenerator');
const toolbox = require('../mcp/toolbox');
const { generateFeedback, generateExecutionFeedback, mapFailuresToModules } = require('../agents/feedback');
const { integrate } = require('../agents/integration');
const { enqueueJob, discardCallback } = require('../queue/queue');
const Task = require('../models/Task');
const ModuleModel = require('../models/Module');
const Output = require('../models/Output');
const FeedbackLog = require('../models/FeedbackLog');
const config = require('../../config/default');
const logger = require('../utils/logger').forAgent('Controller');
const tracer = require('../observability/tracer');
const { computeOutcome } = require('./outcome');
const modelsConfig = require('../../config/models');
const { redact } = require('../utils/redact');

// In-memory handles for pipelines (keyed by taskId). Durable state lives in MongoDB;
// these exist only for status reporting and cancellation of runs owned by THIS process.
const pipelines = new Map();
const activeRuns = new Map(); // taskId → { runId, cancelled, approval? }

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

class PipelineCancelledError extends Error {
  constructor() { super('Pipeline cancelled'); this.name = 'PipelineCancelledError'; }
}
class ModuleTimeoutError extends Error {
  constructor(name, ms) { super(`Module "${name}" timed out after ${ms}ms waiting for the worker`); this.name = 'ModuleTimeoutError'; }
}

function assertNotCancelled(taskId) {
  if (activeRuns.get(taskId)?.cancelled) throw new PipelineCancelledError();
}

/**
 * Core Controller — Orchestrates the entire AI Factory pipeline.
 *
 * Flow:
 * 1. Receives idea → creates Task in DB (identical in-flight ideas are de-duplicated)
 * 2. Calls Decomposer → stores modules
 * 3. For each module: prompt (aware of already-built siblings) → worker via BullMQ →
 *    validator → feedback → retry (bounded by MAX_ITERATIONS)
 * 4. Integration → sandboxed tests → repair loop (bounded by EXEC_MAX_REPAIR_ROUNDS)
 * 5. Outcome verdict (verified / unverified / failed), persisted with the task
 *
 * Every module's state is persisted as it completes, so a run interrupted by a
 * restart is resumed from its completed modules (recoverInterruptedPipelines).
 */

/**
 * Start a new pipeline for the given idea.
 * @param {string} idea
 * @returns {Object} { taskId, status, duplicate? }
 */
async function startPipeline(idea) {
  // De-duplicate: a double-click or client retry must not start a second identical run
  const since = new Date(Date.now() - config.pipeline.dedupeWindowMs);
  const existing = await Task.findOne({ idea, status: { $nin: TERMINAL_STATUSES }, createdAt: { $gte: since } });
  if (existing && activeRuns.has(existing.taskId)) {
    logger.info('Duplicate request — returning the in-flight pipeline', { taskId: existing.taskId });
    return { taskId: existing.taskId, status: 'already-running', duplicate: true };
  }

  const taskId = uuid();
  logger.info(`Starting pipeline for: "${idea}"`, { taskId });

  await Task.create({ taskId, idea, status: 'pending' });
  launch(taskId, idea, { resume: false });
  return { taskId, status: 'started' };
}

/**
 * Run a pipeline in the background under a trace. Never throws: a failure is
 * persisted on the task so it cannot be left looking "running".
 */
function launch(taskId, idea, { resume }) {
  const pipeline = new PipelineState(taskId);
  pipelines.set(taskId, pipeline);
  const runId = uuid().slice(0, 8);
  activeRuns.set(taskId, { runId, cancelled: false });

  return tracer.trace('pipeline', { id: taskId, input: { idea }, metadata: { runId, resume } }, async (h) => {
    await runPipeline(taskId, idea, pipeline, { resume, runId });
    h.setOutput({ stage: pipeline.stage });
  }).catch((err) => {
    logger.error(`Pipeline ended with error: ${err.message}`, { taskId });
  }).finally(() => {
    activeRuns.delete(taskId);
  });
}

/**
 * Request cancellation of a running pipeline (owned by this process).
 * @returns {boolean} true if a running pipeline was signalled
 */
function cancelPipeline(taskId) {
  const run = activeRuns.get(taskId);
  if (!run) return false;
  run.cancelled = true;
  logger.info('Cancellation requested', { taskId });
  return true;
}

/**
 * Mark everything that was in flight as failed, persist the reason on the task.
 */
async function finalizeFailure(taskId, pipeline, err) {
  const cancelled = err instanceof PipelineCancelledError;
  const stage = cancelled ? STAGES.CANCELLED : STAGES.FAILED;
  try { pipeline.transition(stage); } catch (_) { /* already terminal */ }
  await ModuleModel.updateMany(
    { taskId, status: { $nin: ['completed', 'failed'] } },
    { status: 'failed' },
  ).catch(() => {});
  try {
    await Task.findOneAndUpdate({ taskId }, {
      status: cancelled ? 'cancelled' : 'failed',
      error: redact(err.message).slice(0, 1000),
    });
  } catch (dbErr) {
    // The database itself is failing: we cannot record the failure. Don't mask the original
    // error; startup recovery will find this task still non-terminal and settle it.
    logger.error(`Could not persist failure state: ${redact(dbErr.message)}`, { taskId });
  }
}

/**
 * Optional human gate before generated code is executed.
 * Resolves true (approved) or false (rejected / timed out). Cancellation rejects.
 */
async function awaitExecutionApproval(taskId, pipeline) {
  if (!config.pipeline.requireExecutionApproval) return true;
  const run = activeRuns.get(taskId);
  pipeline.transition(STAGES.AWAITING_APPROVAL);
  await Task.findOneAndUpdate({ taskId }, { status: 'awaiting-approval' });
  logger.info('Waiting for human approval before executing generated code', { taskId });

  const decision = await new Promise((resolve) => {
    let timer; let poll;
    const done = (value) => { clearTimeout(timer); clearInterval(poll); resolve(value); }; // always release both timers
    timer = setTimeout(() => done({ approved: false, reason: 'timed out' }), config.pipeline.approvalTimeoutMs);
    poll = setInterval(() => { if (run?.cancelled) done({ cancelled: true }); }, 200);
    run.approval = { resolve: (approved) => done({ approved, reason: approved ? 'approved' : 'rejected' }) };
  });
  if (run) run.approval = null;
  if (decision.cancelled) throw new PipelineCancelledError();

  pipeline.transition(STAGES.INTEGRATING);
  await Task.findOneAndUpdate({ taskId }, { status: 'integrating' });
  return decision.approved ? true : decision.reason;
}

/**
 * Approve or reject a pipeline waiting at the execution gate.
 * @returns {boolean} false if the task is not currently waiting in this process
 */
function resolveApproval(taskId, approved) {
  const run = activeRuns.get(taskId);
  if (!run || !run.approval) return false;
  run.approval.resolve(!!approved);
  return true;
}

/**
 * Execute the full pipeline sequentially. With resume=true, continue a task
 * whose modules were persisted before the process stopped.
 */
async function runPipeline(taskId, idea, pipeline, { resume = false, runId = 'r0' } = {}) {
  // Track completed module outputs for inter-module context passing
  const completedOutputs = new Map(); // moduleName → { code, exports[], filePath, ... }

  try {
    await Task.findOneAndUpdate({ taskId }, { runId });
    let moduleDocs;

    if (resume) {
      // ─── Resume: rebuild state from what was persisted ────────────
      moduleDocs = await ModuleModel.find({ taskId }).sort({ priority: 1 });
      if (!moduleDocs.length) {
        throw new Error('Interrupted before decomposition finished — please resubmit the idea');
      }
      for (const doc of moduleDocs) {
        if (doc.status === 'completed' && doc.output) {
          completedOutputs.set(doc.name, {
            code: doc.output,
            exports: extractExportNames(doc.output),
            filePath: getModuleFilePath(doc.type, doc.name),
            type: doc.type,
            name: doc.name,
            validationPassed: !!doc.validationPassed,
            usedFallback: !!doc.usedFallback,
            score: doc.qualityScore,
          });
        } else if (doc.status !== 'pending') {
          // Was mid-flight when the process stopped: rebuild it from its last prompt
          await ModuleModel.findOneAndUpdate({ moduleId: doc.moduleId }, { status: 'pending' });
          doc.status = 'pending';
        }
      }
      pipeline.restore(STAGES.BUILDING);
      await Task.findOneAndUpdate({ taskId }, { status: 'building' });
      logger.info(`Resuming: ${completedOutputs.size}/${moduleDocs.length} modules already complete`, { taskId });
    } else {
      // ─── Stage 1: Decompose ──────────────────────────────────────
      assertNotCancelled(taskId);
      pipeline.transition(STAGES.DECOMPOSING);
      await Task.findOneAndUpdate({ taskId }, { status: 'decomposing' });
      logger.info('Stage 1: Decomposing idea', { taskId });

      const modules = await tracer.span('decompose', { input: { idea } }, async (h) => {
        const mods = await decompose({ idea });
        h.setOutput(mods.map((m) => m.name));
        return mods;
      });

      moduleDocs = [];
      for (const mod of modules) {
        const doc = await ModuleModel.create({
          moduleId: mod.moduleId,
          taskId,
          name: mod.name,
          description: mod.description,
          type: mod.type,
          dependencies: mod.dependencies,
          priority: mod.priority,
          status: 'pending',
        });
        moduleDocs.push(doc);
      }

      await Task.findOneAndUpdate({ taskId }, {
        modules: moduleDocs.map((m) => m.moduleId),
        'metadata.totalModules': moduleDocs.length,
      });
      logger.info(`Decomposed into ${moduleDocs.length} modules`, { taskId });

      pipeline.transition(STAGES.BUILDING);
      await Task.findOneAndUpdate({ taskId }, { status: 'building' });
    }

    // ─── Stage 2–3: prompt + build + validate each module ──────────
    // Modules run sequentially; each prompt is generated right before its module is
    // built, so it can reference the real exports and file paths of finished siblings.
    for (const mod of moduleDocs) {
      assertNotCancelled(taskId);
      if (completedOutputs.has(mod.name)) continue;

      if (!mod.prompt) {
        const siblingModules = [...completedOutputs].map(([name, info]) => ({ name, exports: info.exports, filePath: info.filePath }));
        const { prompt, model } = await tracer.span(`prompt:${mod.name}`, { metadata: { type: mod.type } }, async (h) => {
          const out = await generatePrompt({
            module: { name: mod.name, description: mod.description, type: mod.type, dependencies: mod.dependencies },
            context: idea,
            siblingModules,
          });
          h.setOutput({ model: out.model, promptChars: out.prompt.length });
          return out;
        });
        await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { prompt, assignedModel: model, status: 'prompting' });
        mod.prompt = prompt;
        mod.assignedModel = model;
      }

      await processModule(taskId, mod, pipeline, 0, completedOutputs, runId);
    }

    // ─── Stage 3b: All modules validated ─────────────────────────
    assertNotCancelled(taskId);
    pipeline.transition(STAGES.VALIDATING);
    await Task.findOneAndUpdate({ taskId }, { status: 'validating' });
    logger.info('Stage 3b: All modules built and validated', { taskId });

    // ─── Stage 4: Integration ────────────────────────────────────
    pipeline.transition(STAGES.INTEGRATING);
    await Task.findOneAndUpdate({ taskId }, { status: 'integrating' });
    logger.info('Stage 4: Integrating modules', { taskId });

    // Reload modules with latest outputs
    const completedModules = await ModuleModel.find({ taskId, status: 'completed' }).lean();

    const result = await tracer.span('integrate', { metadata: { modules: completedModules.length } }, async (h) => {
      const out = await integrate({ modules: completedModules });
      h.setOutput({ files: out.files.length });
      return out;
    });

    // ─── Stage 5: Sandboxed test execution + repair loop ─────────
    const gate = await awaitExecutionApproval(taskId, pipeline);
    if (gate !== true) {
      // Not approved: keep the artifact, but be explicit that nothing was verified
      logger.info(`Execution not approved (${gate}) — finishing unverified`, { taskId });
      result.execution = { success: false, skipped: true, errors: [`Execution ${gate} by operator`], logs: [], tests: { total: 0, passed: 0, failed: 0, failures: [] } };
      result.executionAttempts = [];
    } else {
      logger.info('Stage 5: Running generated tests in sandbox', { taskId });
      const final = await executeWithRepair({ taskId, result, moduleDocs, pipeline, completedOutputs, runId });
      result.files = final.result.files;
      result.packageJson = final.result.packageJson;
      result.execution = final.execution;
      result.executionAttempts = final.attempts;
    }

    // Finishing the workflow is not the same as producing a working artifact
    const outcome = computeOutcome({
      modules: [...completedOutputs.values()],
      execution: result.execution,
      provider: modelsConfig.provider,
    });
    result.outcome = outcome;
    const failed = outcome.verdict === 'failed';

    await Task.findOneAndUpdate({ taskId }, {
      status: failed ? 'failed' : 'completed',
      error: failed ? redact(outcome.reasons.join(' | ')).slice(0, 1000) : null,
      finalOutput: result, // kept even on failure so the artifact can be inspected
    });

    pipeline.transition(failed ? STAGES.FAILED : STAGES.COMPLETED);
    logger.log(failed ? 'warn' : 'info', `Pipeline ${failed ? 'FAILED' : 'finished'} — verdict: ${outcome.verdict}`, {
      taskId,
      verdict: outcome.verdict,
      reasons: outcome.reasons,
      fileCount: result.files.length,
      moduleCount: completedModules.length,
    });

  } catch (err) {
    const cancelled = err instanceof PipelineCancelledError;
    logger.log(cancelled ? 'info' : 'error', `Pipeline ${cancelled ? 'CANCELLED' : 'FAILED'}: ${err.message}`, { taskId });
    await finalizeFailure(taskId, pipeline, err);
    throw err;
  }
}

/**
 * Startup recovery. Tasks left in a non-terminal state by a previous process are
 * either resumed from their persisted modules (default; at most MAX_RESUMES times
 * so a crash loop cannot spin forever) or marked failed with an accurate reason.
 * @returns {Promise<{resumed: string[], failed: string[]}>}
 */
async function recoverInterruptedPipelines({ resume = process.env.PIPELINE_RESUME !== 'false', maxResumes = 2 } = {}) {
  const stuck = await Task.find({ status: { $nin: TERMINAL_STATUSES } });
  const summary = { resumed: [], failed: [] };

  for (const task of stuck) {
    if (activeRuns.has(task.taskId)) continue; // owned by this process
    const hasModules = (task.modules || []).length > 0;

    if (resume && hasModules && (task.resumeCount || 0) < maxResumes) {
      await Task.findOneAndUpdate({ taskId: task.taskId }, { $inc: { resumeCount: 1 }, error: null });
      logger.info(`Resuming interrupted pipeline (attempt ${(task.resumeCount || 0) + 1})`, { taskId: task.taskId });
      launch(task.taskId, task.idea, { resume: true });
      summary.resumed.push(task.taskId);
    } else {
      const reason = !hasModules
        ? 'Interrupted by a restart before decomposition finished — please resubmit'
        : (task.resumeCount || 0) >= maxResumes ? `Interrupted by repeated restarts (resumed ${task.resumeCount}×) — giving up`
          : 'Interrupted by a restart (automatic resume disabled)';
      await ModuleModel.updateMany({ taskId: task.taskId, status: { $nin: ['completed', 'failed'] } }, { status: 'failed' });
      await Task.findOneAndUpdate({ taskId: task.taskId }, { status: 'failed', error: reason });
      summary.failed.push(task.taskId);
    }
  }
  return summary;
}

/**
 * Run the generated project's tests in the sandbox. On failure, blame the
 * owning modules, feed the real failures back to the coder, rebuild and retry
 * within config.execution.maxRepairRounds. Never reports success unless the
 * tests actually passed.
 */
async function executeWithRepair({ taskId, result, moduleDocs, pipeline, completedOutputs, runId }) {
  const maxRounds = config.execution.maxRepairRounds;
  const attempts = [];
  let current = result;

  // Repair rounds already spent before a restart count against the budget, so a crash
  // loop cannot keep granting fresh repair attempts
  const persisted = await Task.findOne({ taskId });
  const startRound = persisted?.repairRound || 0;

  for (let round = startRound; ; round++) {
    assertNotCancelled(taskId);
    let execution;
    try {
      execution = await tracer.span('sandbox.execute', { metadata: { round } }, async (h) => {
        const ex = await toolbox.execute({ files: current.files });
        h.setOutput({ success: ex.success, skipped: ex.skipped, tests: ex.tests && { passed: ex.tests.passed, total: ex.tests.total }, errors: ex.errors });
        return ex;
      });
    } catch (err) {
      execution = { success: false, skipped: false, errors: [err.message], logs: [], tests: { total: 0, passed: 0, failed: 0, failures: [] } };
    }

    attempts.push({
      round,
      success: execution.success,
      skipped: !!execution.skipped,
      installSuccess: !!execution.installSuccess,
      passed: execution.tests?.passed ?? 0,
      total: execution.tests?.total ?? 0,
      failed: execution.tests?.failed ?? 0,
      errors: execution.errors,
    });
    logger.info(`Execution round ${round}: success=${execution.success}, tests=${execution.tests?.passed}/${execution.tests?.total}`, { taskId });

    if (execution.success || execution.skipped) return { result: current, execution, attempts };

    const failures = execution.tests?.failures || [];
    const blame = mapFailuresToModules(failures, current.files);
    const targets = moduleDocs.filter((m) => blame.has(m.name));

    if (round >= maxRounds) {
      logger.warn(`Execution still failing after ${maxRounds} repair round(s) — reporting failure`, { taskId });
      return { result: current, execution, attempts };
    }
    if (targets.length === 0) {
      logger.warn('Execution failed but no module could be blamed — cannot repair', { taskId });
      return { result: current, execution, attempts };
    }

    await Task.findOneAndUpdate({ taskId }, { repairRound: round + 1 });

    // Feed the real failures back to the coder for each blamed module
    for (const mod of targets) {
      const feedback = await tracer.span(`exec-feedback:${mod.name}`, { metadata: { round } }, async () => generateExecutionFeedback({
        failures: blame.get(mod.name),
        originalPrompt: mod.prompt,
        code: completedOutputs.get(mod.name)?.code,
        iteration: round,
      }));
      await FeedbackLog.create({
        feedbackId: uuid(),
        moduleId: mod.moduleId,
        taskId,
        iteration: round,
        issues: blame.get(mod.name).map((f) => ({ type: 'error', message: `Test failed: ${f.test}`, severity: 8 })),
        refinedPrompt: feedback.refinedPrompt,
      });
      mod.prompt = feedback.refinedPrompt;
      await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { prompt: feedback.refinedPrompt, status: 'feedback' });
      await processModule(taskId, mod, pipeline, 0, completedOutputs, runId);
    }

    const completedModules = await ModuleModel.find({ taskId, status: 'completed' }).lean();
    current = await tracer.span('integrate', { metadata: { round, repair: true } }, () => integrate({ modules: completedModules }));
  }
}

/**
 * Process a single module through the build → validate → (feedback) loop.
 */
function processModule(taskId, mod, pipeline, iteration, completedOutputs, runId) {
  return tracer.span(`module:${mod.name}`, { metadata: { iteration } }, () =>
    processModuleImpl(taskId, mod, pipeline, iteration, completedOutputs, runId));
}

/**
 * Enqueue a worker job and wait for it — but not forever. A lost job or a dead
 * worker would otherwise leave the pipeline (and the task) running indefinitely.
 */
function dispatchJob(jobData, timeoutMs, moduleName) {
  return new Promise((resolve, reject) => {
    const moduleId = jobData.moduleContext.moduleId;
    const timer = setTimeout(() => {
      discardCallback(moduleId);
      reject(new ModuleTimeoutError(moduleName, timeoutMs));
    }, timeoutMs);
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };

    Promise.resolve(enqueueJob(jobData, (err, workerResult) => {
      if (err) settle(reject, err);
      else settle(resolve, workerResult);
    })).catch((err) => { discardCallback(moduleId); settle(reject, err); });
  });
}

async function processModuleImpl(taskId, mod, pipeline, iteration, completedOutputs, runId) {
  const maxIterations = config.pipeline.maxIterations;
  assertNotCancelled(taskId);

  logger.info(`Building module: "${mod.name}" (iteration ${iteration})`, {
    taskId,
    moduleId: mod.moduleId,
    iteration,
  });

  await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { status: 'queued', iteration });

  // Dispatch to worker via queue
  const result = await dispatchJob({
    prompt: mod.prompt,
    model: mod.assignedModel,
    traceContext: tracer.currentContext(),
    moduleContext: {
      taskId,
      runId,
      moduleId: mod.moduleId,
      name: mod.name,
      type: mod.type,
      description: mod.description,
      dependencies: mod.dependencies,
      iteration,
    },
  }, config.pipeline.moduleTimeoutMs, mod.name);
  assertNotCancelled(taskId);

  // Save output
  const outputId = uuid();
  await Output.create({
    outputId,
    moduleId: mod.moduleId,
    taskId,
    code: result.code,
    language: result.language,
    iteration,
    model: mod.assignedModel,
    explanation: result.explanation,
  });

  // Update module with latest output
  await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, {
    output: result.code,
    language: result.language,
    status: 'validating',
  });

  // ─── Validate ──────────────────────────────────────────────────
  logger.info(`Validating module: "${mod.name}"`, { taskId, moduleId: mod.moduleId, iteration });

  const validation = await tracer.span('validate', { metadata: { iteration } }, async (h) => {
    const v = await toolbox.validate({ code: result.code, moduleName: mod.name, requirements: mod.description });
    h.setOutput({ score: v.score, passed: v.passed, issues: v.issues.map((i) => i.message) });
    return v;
  });

  await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, {
    qualityScore: validation.score,
  });

  await Output.findOneAndUpdate({ outputId }, { score: validation.score });

  if (validation.passed) {
    // ✅ Passed — mark complete and register in context
    await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { status: 'completed', validationPassed: true, usedFallback: !!result.fallback });
    await Task.findOneAndUpdate({ taskId }, { $inc: { 'metadata.completedModules': 1 } });

    // Register exports for inter-module context passing
    const exportNames = extractExportNames(result.code);
    completedOutputs.set(mod.name, {
      code: result.code,
      exports: exportNames,
      filePath: getModuleFilePath(mod.type, mod.name),
      type: mod.type,
      name: mod.name,
      validationPassed: true,
      usedFallback: !!result.fallback,
      score: validation.score,
    });

    logger.info(`Module PASSED: "${mod.name}" — score: ${validation.score}, exports: [${exportNames.join(', ')}]`, {
      taskId, moduleId: mod.moduleId, score: validation.score,
    });
    return;
  }

  // ❌ Failed — enter feedback loop
  if (iteration >= maxIterations - 1) {
    logger.warn(`Module "${mod.name}" reached max iterations (${maxIterations}), accepting with score: ${validation.score}`, {
      taskId, moduleId: mod.moduleId,
    });
    // Built, but NEVER passed validation: keep it so integration still has a file,
    // flag it so the run cannot be reported as verified.
    await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { status: 'completed', validationPassed: false, usedFallback: !!result.fallback });
    await Task.findOneAndUpdate({ taskId }, { $inc: { 'metadata.completedModules': 1 } });

    const exportNames = extractExportNames(result.code);
    completedOutputs.set(mod.name, {
      code: result.code, exports: exportNames, filePath: getModuleFilePath(mod.type, mod.name), type: mod.type,
      name: mod.name, validationPassed: false, usedFallback: !!result.fallback, score: validation.score,
    });
    return;
  }

  logger.info(`Module FAILED validation: "${mod.name}" — score: ${validation.score}, entering feedback loop`, {
    taskId, moduleId: mod.moduleId, iteration,
  });

  const feedback = await tracer.span('feedback', { metadata: { iteration } }, () => generateFeedback({
    issues: validation.issues,
    originalPrompt: mod.prompt,
    code: result.code,
    iteration,
  }));

  await FeedbackLog.create({
    feedbackId: uuid(),
    moduleId: mod.moduleId,
    taskId,
    iteration,
    issues: validation.issues,
    refinedPrompt: feedback.refinedPrompt,
    previousScore: validation.score,
  });

  await Task.findOneAndUpdate({ taskId }, { $inc: { 'metadata.totalIterations': 1 } });

  mod.prompt = feedback.refinedPrompt;
  await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, {
    prompt: feedback.refinedPrompt,
    status: 'feedback',
  });

  return processModule(taskId, mod, pipeline, iteration + 1, completedOutputs, runId);
}

/**
 * Extract export names from module.exports in code.
 */
function extractExportNames(code) {
  const names = [];
  // Match: module.exports = { name1, name2, ... }
  const objMatch = code.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (objMatch) {
    const inner = objMatch[1];
    const parts = inner.split(',').map(s => s.trim().split(':')[0].split('(')[0].trim()).filter(Boolean);
    names.push(...parts);
  }
  // Match: module.exports = functionName
  const singleMatch = code.match(/module\.exports\s*=\s*([A-Za-z_]\w*)/);
  if (singleMatch && names.length === 0) {
    names.push(singleMatch[1]);
  }
  return names;
}

/**
 * Get the output file path for a module based on its type and name.
 */
function getModuleFilePath(type, name) {
  const nameSlug = name
    .toLowerCase()
    .replace(/\s+module$/i, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  const pathMap = {
    config:          `config/${nameSlug}.js`,
    database:        `src/models/index.js`,
    authentication:  `src/auth/auth.js`,
    api:             `src/routes/api.js`,
    middleware:       `src/middleware/index.js`,
    'business-logic': `src/services/${nameSlug}.js`,
    utilities:        `src/utils/${nameSlug}.js`,
  };

  return pathMap[type] || `src/${nameSlug}.js`;
}

/**
 * Get the current status of a pipeline.
 */
async function getPipelineStatus(taskId) {
  const task = await Task.findOne({ taskId }).lean();
  if (!task) return null;

  const modules = await ModuleModel.find({ taskId }).lean();
  const pipeline = pipelines.get(taskId);

  return {
    taskId: task.taskId,
    idea: task.idea,
    status: task.status,
    pipelineStage: pipeline?.stage || task.status,
    pipelineHistory: pipeline?.history || [],
    metadata: task.metadata,
    modules: modules.map((m) => ({
      moduleId: m.moduleId,
      name: m.name,
      type: m.type,
      status: m.status,
      qualityScore: m.qualityScore,
      iteration: m.iteration,
      assignedModel: m.assignedModel,
    })),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * Get the final output of a completed pipeline.
 */
async function getPipelineOutput(taskId) {
  const task = await Task.findOne({ taskId }).lean();
  if (!task) return null;
  return task.finalOutput;
}

/**
 * List all pipelines.
 */
async function listPipelines() {
  return Task.find({}, 'taskId idea status metadata createdAt updatedAt')
    .sort({ createdAt: -1 })
    .lean();
}

module.exports = {
  startPipeline,
  cancelPipeline,
  resolveApproval,
  recoverInterruptedPipelines,
  PipelineCancelledError,
  ModuleTimeoutError,
  getPipelineStatus,
  getPipelineOutput,
  listPipelines,
};
