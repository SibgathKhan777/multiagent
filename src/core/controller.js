const { v4: uuid } = require('uuid');
const { STAGES, PipelineState } = require('./pipeline');
const { decompose } = require('../agents/decomposer');
const { generatePrompt } = require('../agents/promptGenerator');
const { validate } = require('../agents/validator');
const { generateFeedback } = require('../agents/feedback');
const { integrate } = require('../agents/integration');
const { execute } = require('../agents/executor');
const { enqueueJob } = require('../queue/queue');
const Task = require('../models/Task');
const ModuleModel = require('../models/Module');
const Output = require('../models/Output');
const FeedbackLog = require('../models/FeedbackLog');
const config = require('../../config/default');
const logger = require('../utils/logger').forAgent('Controller');

// In-memory store for pipeline state machines (keyed by taskId)
const pipelines = new Map();

/**
 * Core Controller — Orchestrates the entire AI Factory pipeline.
 *
 * Flow:
 * 1. Receives idea → creates Task in DB
 * 2. Calls Decomposer → stores modules
 * 3. Calls Prompt Generator for each module
 * 4. Enqueues worker jobs via BullMQ
 * 5. On worker completion → calls Validator
 * 6. If validation fails → calls Feedback Agent → re-enqueues (max N iterations)
 * 7. If all modules pass → calls Integration Agent
 * 8. Stores final output in Task
 */

/**
 * Start a new pipeline for the given idea.
 * @param {string} idea
 * @returns {Object} { taskId, status }
 */
async function startPipeline(idea) {
  const taskId = uuid();
  logger.info(`Starting pipeline for: "${idea}"`, { taskId });

  // Create pipeline state machine
  const pipeline = new PipelineState(taskId);
  pipelines.set(taskId, pipeline);

  // Create task in DB
  const task = await Task.create({
    taskId,
    idea,
    status: 'pending',
  });

  // Run pipeline async (don't await — return immediately)
  runPipeline(taskId, idea, pipeline).catch((err) => {
    logger.error(`Pipeline failed: ${err.message}`, { taskId, error: err.stack });
  });

  return { taskId, status: 'started' };
}

/**
 * Execute the full pipeline sequentially.
 */
async function runPipeline(taskId, idea, pipeline) {
  // Track completed module outputs for inter-module context passing
  const completedOutputs = new Map(); // moduleName → { code, exports[], filePath }

  try {
    // ─── Stage 1: Decompose ──────────────────────────────────────
    pipeline.transition(STAGES.DECOMPOSING);
    await Task.findOneAndUpdate({ taskId }, { status: 'decomposing' });
    logger.info('Stage 1: Decomposing idea', { taskId });

    const modules = await decompose({ idea });

    // Save modules to DB
    const moduleDocs = [];
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

    // ─── Stage 2: Generate Prompts ───────────────────────────────
    pipeline.transition(STAGES.PROMPTING);
    await Task.findOneAndUpdate({ taskId }, { status: 'prompting' });
    logger.info('Stage 2: Generating prompts', { taskId });

    for (const mod of moduleDocs) {
      // Build sibling context from already-completed modules
      const siblingModules = [];
      for (const [name, info] of completedOutputs) {
        siblingModules.push({ name, exports: info.exports, filePath: info.filePath });
      }

      const { prompt, model } = await generatePrompt({
        module: { name: mod.name, description: mod.description, type: mod.type, dependencies: mod.dependencies },
        context: idea,
        siblingModules,
      });

      await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, {
        prompt,
        assignedModel: model,
        status: 'prompting',
      });

      mod.prompt = prompt;
      mod.assignedModel = model;
    }

    logger.info('All prompts generated', { taskId });

    // ─── Stage 3: Build (dispatch to workers) ────────────────────
    pipeline.transition(STAGES.BUILDING);
    await Task.findOneAndUpdate({ taskId }, { status: 'building' });
    logger.info('Stage 3: Dispatching to workers', { taskId });

    // Process modules sequentially — each module gets context from previous ones
    for (const mod of moduleDocs) {
      await processModule(taskId, mod, pipeline, 0, completedOutputs);
    }

    // ─── Stage 3b: All modules validated ─────────────────────────
    pipeline.transition(STAGES.VALIDATING);
    await Task.findOneAndUpdate({ taskId }, { status: 'validating' });
    logger.info('Stage 3b: All modules built and validated', { taskId });

    // ─── Stage 4: Integration ────────────────────────────────────
    pipeline.transition(STAGES.INTEGRATING);
    await Task.findOneAndUpdate({ taskId }, { status: 'integrating' });
    logger.info('Stage 4: Integrating modules', { taskId });

    // Reload modules with latest outputs
    const completedModules = await ModuleModel.find({ taskId, status: 'completed' }).lean();

    const result = await integrate({ modules: completedModules });

    // ─── Stage 5: Live Execution ─────────────────────────────────
    logger.info('Stage 5: Live project execution', { taskId });
    try {
      const execResult = await execute({ files: result.files, projectName: result.packageJson?.name });
      result.execution = execResult;
      logger.info(`Execution result: files=${execResult.filesWritten}, install=${execResult.installSuccess}, started=${execResult.started}`, { taskId });
    } catch (execErr) {
      logger.warn(`Live execution skipped: ${execErr.message}`, { taskId });
      result.execution = { success: false, errors: [execErr.message], logs: ['⚠️ Execution skipped'] };
    }

    // Save final output
    await Task.findOneAndUpdate({ taskId }, {
      status: 'completed',
      finalOutput: result,
    });

    pipeline.transition(STAGES.COMPLETED);
    logger.info('Pipeline COMPLETED successfully', {
      taskId,
      fileCount: result.files.length,
      moduleCount: completedModules.length,
    });

  } catch (err) {
    logger.error(`Pipeline FAILED: ${err.message}`, { taskId, error: err.stack });
    try { pipeline.transition(STAGES.FAILED); } catch (_) { /* already terminal */ }
    await Task.findOneAndUpdate({ taskId }, { status: 'failed', error: err.message });
    throw err;
  }
}

/**
 * Process a single module through the build → validate → (feedback) loop.
 */
async function processModule(taskId, mod, pipeline, iteration, completedOutputs) {
  const maxIterations = config.pipeline.maxIterations;

  logger.info(`Building module: "${mod.name}" (iteration ${iteration})`, {
    taskId,
    moduleId: mod.moduleId,
    iteration,
  });

  await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { status: 'queued', iteration });

  // Dispatch to worker via queue
  const result = await new Promise((resolve, reject) => {
    enqueueJob(
      {
        prompt: mod.prompt,
        model: mod.assignedModel,
        moduleContext: {
          moduleId: mod.moduleId,
          name: mod.name,
          type: mod.type,
          description: mod.description,
          dependencies: mod.dependencies,
          iteration,
        },
      },
      (err, workerResult) => {
        if (err) reject(err);
        else resolve(workerResult);
      }
    );
  });

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

  const validation = await validate({
    code: result.code,
    moduleName: mod.name,
    requirements: mod.description,
  });

  await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, {
    qualityScore: validation.score,
  });

  await Output.findOneAndUpdate({ outputId }, { score: validation.score });

  if (validation.passed) {
    // ✅ Passed — mark complete and register in context
    await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { status: 'completed' });
    await Task.findOneAndUpdate({ taskId }, { $inc: { 'metadata.completedModules': 1 } });

    // Register exports for inter-module context passing
    const exportNames = extractExportNames(result.code);
    completedOutputs.set(mod.name, {
      code: result.code,
      exports: exportNames,
      filePath: getModuleFilePath(mod.type, mod.name),
      type: mod.type,
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
    await ModuleModel.findOneAndUpdate({ moduleId: mod.moduleId }, { status: 'completed' });
    await Task.findOneAndUpdate({ taskId }, { $inc: { 'metadata.completedModules': 1 } });

    const exportNames = extractExportNames(result.code);
    completedOutputs.set(mod.name, { code: result.code, exports: exportNames, filePath: getModuleFilePath(mod.type, mod.name), type: mod.type });
    return;
  }

  logger.info(`Module FAILED validation: "${mod.name}" — score: ${validation.score}, entering feedback loop`, {
    taskId, moduleId: mod.moduleId, iteration,
  });

  const feedback = await generateFeedback({
    issues: validation.issues,
    originalPrompt: mod.prompt,
    code: result.code,
    iteration,
  });

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

  return processModule(taskId, mod, pipeline, iteration + 1, completedOutputs);
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
  getPipelineStatus,
  getPipelineOutput,
  listPipelines,
};
