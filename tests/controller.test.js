/**
 * Deterministic controller tests: fake DB, fake queue, scripted agents.
 * No MongoDB, Redis, Docker or API key involved.
 */

jest.mock('../src/models/Task', () => require('./helpers/fakeDb').taskModel());
jest.mock('../src/models/Module', () => require('./helpers/fakeDb').moduleModel());
jest.mock('../src/models/Output', () => require('./helpers/fakeDb').plainModel());
jest.mock('../src/models/FeedbackLog', () => require('./helpers/fakeDb').plainModel());

jest.mock('../src/agents/decomposer', () => ({
  decompose: jest.fn(async () => [
    { moduleId: 'm-cfg', name: 'Configuration Module', description: 'config', type: 'config', dependencies: [], priority: 0 },
    { moduleId: 'm-db', name: 'Database Module', description: 'db', type: 'database', dependencies: [], priority: 1 },
  ]),
}));
jest.mock('../src/agents/promptGenerator', () => ({
  generatePrompt: jest.fn(async ({ module: m }) => ({ prompt: `PROMPT for ${m.name}`, model: 'test-model' })),
}));
jest.mock('../src/mcp/toolbox', () => ({ validate: jest.fn(), execute: jest.fn(), close: jest.fn(), enabled: () => false }));
jest.mock('../src/queue/queue', () => ({ enqueueJob: jest.fn(), discardCallback: jest.fn(), initQueue: jest.fn(), closeQueue: jest.fn() }));

const Task = require('../src/models/Task');
const ModuleModel = require('../src/models/Module');
const FeedbackLog = require('../src/models/FeedbackLog');
const toolbox = require('../src/mcp/toolbox');
const queue = require('../src/queue/queue');
const config = require('../config/default');
const modelsConfig = require('../config/models');
const controller = require('../src/core/controller');

const CODE = (name) => `'use strict';\n// ${name}\nfunction run() { return 1; }\nmodule.exports = { run };\n`;
const workerOk = (over = {}) => ({ code: CODE('x'), language: 'javascript', explanation: 'ok', fallback: false, simulated: false, ...over });
const passV = { score: 90, passed: true, issues: [] };
const failV = { score: 40, passed: false, issues: [{ type: 'error', message: 'Syntax error: x', severity: 9 }] };
const okExec = { success: true, skipped: false, installSuccess: true, tests: { total: 4, passed: 4, failed: 0, failures: [] }, errors: [], logs: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await pred(); if (v) return v; await sleep(10); }
  throw new Error('waitFor timed out');
}
const terminal = (id) => waitFor(async () => { const t = await Task.findOne({ taskId: id }); return t && ['completed', 'failed', 'cancelled'].includes(t.status) ? t : null; });

// default: every worker job succeeds immediately
function workerSucceeds(result = workerOk()) {
  queue.enqueueJob.mockImplementation(async (jobData, cb) => { setImmediate(() => cb(null, typeof result === 'function' ? result(jobData) : result)); });
}

beforeEach(() => {
  Task.reset(); ModuleModel.reset(); FeedbackLog.reset();
  jest.clearAllMocks();
  modelsConfig.provider = 'groq';
  config.pipeline.moduleTimeoutMs = 2000;
  config.pipeline.maxIterations = 3;
  config.execution.maxRepairRounds = 2;
  workerSucceeds();
  toolbox.validate.mockResolvedValue(passV);
  toolbox.execute.mockResolvedValue(okExec);
});

describe('controller: success path', () => {
  test('all modules pass and tests pass → completed + verified', async () => {
    const { taskId } = await controller.startPipeline('build a thing');
    const t = await terminal(taskId);
    expect(t.status).toBe('completed');
    expect(t.finalOutput.outcome).toEqual({ verdict: 'verified', reasons: [] });
    expect(ModuleModel.docs.every((m) => m.status === 'completed' && m.validationPassed)).toBe(true);
    expect(t.finalOutput.files.length).toBeGreaterThan(0);
    // Prompts are generated per module, the second one aware of the first as a sibling
    const { generatePrompt } = require('../src/agents/promptGenerator');
    expect(generatePrompt.mock.calls[1][0].siblingModules.map((s) => s.name)).toEqual(['Configuration Module']);
  });
});

describe('controller: validation, repair and retry exhaustion', () => {
  test('validation failure then success → repaired within the iteration budget', async () => {
    toolbox.validate.mockResolvedValueOnce(failV).mockResolvedValue(passV);
    const { taskId } = await controller.startPipeline('repair me');
    const t = await terminal(taskId);
    expect(t.status).toBe('completed');
    expect(FeedbackLog.docs).toHaveLength(1);
    expect(queue.enqueueJob).toHaveBeenCalledTimes(3); // cfg twice (retry) + db once
    expect(t.metadata.totalIterations).toBe(1);
  });

  test('retries are bounded: exhausted modules are flagged and the task FAILS (artifact kept)', async () => {
    toolbox.validate.mockResolvedValue(failV);
    const { taskId } = await controller.startPipeline('never validates');
    const t = await terminal(taskId);
    expect(queue.enqueueJob).toHaveBeenCalledTimes(config.pipeline.maxIterations * 2);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/did not pass validation/);
    expect(t.finalOutput.outcome.verdict).toBe('failed');
    expect(t.finalOutput.files.length).toBeGreaterThan(0);
    expect(ModuleModel.docs.every((m) => m.validationPassed === false)).toBe(true);
  });
});

describe('controller: worker / provider failures', () => {
  test('provider outage masked by a template fallback → failed, reason names the module', async () => {
    workerSucceeds(workerOk({ fallback: true }));
    const { taskId } = await controller.startPipeline('provider down');
    const t = await terminal(taskId);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/template code was substituted/);
  });

  test('simulated provider is never reported as verified', async () => {
    modelsConfig.provider = 'simulated';
    workerSucceeds(workerOk({ simulated: true }));
    const { taskId } = await controller.startPipeline('demo mode');
    const t = await terminal(taskId);
    expect(t.status).toBe('completed');
    expect(t.finalOutput.outcome.verdict).toBe('unverified');
  });

  test('worker error → task failed, in-flight modules failed, nothing left running', async () => {
    queue.enqueueJob.mockImplementation(async (_d, cb) => setImmediate(() => cb(new Error('worker exploded'))));
    const { taskId } = await controller.startPipeline('worker dies');
    const t = await terminal(taskId);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/worker exploded/);
    expect(ModuleModel.docs.every((m) => m.status === 'failed')).toBe(true);
  });

  test('worker timeout → bounded wait, task failed, callback discarded', async () => {
    config.pipeline.moduleTimeoutMs = 50;
    queue.enqueueJob.mockImplementation(async () => { /* job never completes */ });
    const { taskId } = await controller.startPipeline('worker hangs');
    const t = await terminal(taskId);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/timed out/);
    expect(queue.discardCallback).toHaveBeenCalledWith('m-cfg');
  });

  test('queue unavailable (enqueue rejects) → failed, not stuck', async () => {
    queue.enqueueJob.mockRejectedValue(new Error('Queue not initialized'));
    const { taskId } = await controller.startPipeline('no redis');
    const t = await terminal(taskId);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/Queue not initialized/);
  });

  test('error messages are redacted before being persisted', async () => {
    const key = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
    queue.enqueueJob.mockImplementation(async (_d, cb) => setImmediate(() => cb(new Error(`401 bad key ${key}`))));
    const { taskId } = await controller.startPipeline('leaky error');
    const t = await terminal(taskId);
    expect(t.error).not.toContain(key);
  });
});

describe('controller: sandbox results', () => {
  test('failing generated tests → repair round → pass', async () => {
    const failing = {
      success: false, skipped: false, installSuccess: true,
      tests: { total: 4, passed: 3, failed: 1, failures: [{ file: 'tests/database-module.test.js', test: 'Database loads', message: 'boom' }] },
      errors: ['1 test failure(s)'], logs: [],
    };
    toolbox.execute.mockResolvedValueOnce(failing).mockResolvedValue(okExec);
    const { taskId } = await controller.startPipeline('tests fail once');
    const t = await terminal(taskId);
    expect(t.status).toBe('completed');
    expect(t.finalOutput.executionAttempts.map((a) => a.success)).toEqual([false, true]);
    expect(FeedbackLog.docs.some((f) => f.issues[0].message.includes('Database loads'))).toBe(true);
  });

  test('tests keep failing → repair budget respected, task failed with test counts', async () => {
    toolbox.execute.mockResolvedValue({
      success: false, skipped: false, installSuccess: true,
      tests: { total: 4, passed: 3, failed: 1, failures: [{ file: 'tests/database-module.test.js', test: 'x', message: 'boom' }] },
      errors: ['1 test failure(s)'], logs: [],
    });
    const { taskId } = await controller.startPipeline('tests always fail');
    const t = await terminal(taskId);
    expect(toolbox.execute).toHaveBeenCalledTimes(config.execution.maxRepairRounds + 1);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/3\/4 tests passed/);
  });

  test('failed dependency installation → failed (no repair possible)', async () => {
    toolbox.execute.mockResolvedValue({ success: false, skipped: false, installSuccess: false, tests: { total: 0, passed: 0, failed: 0, failures: [] }, errors: ['npm install failed (exit code 1): ERESOLVE'], logs: [] });
    const { taskId } = await controller.startPipeline('bad deps');
    const t = await terminal(taskId);
    expect(t.status).toBe('failed');
    expect(toolbox.execute).toHaveBeenCalledTimes(1);
    expect(t.error).toMatch(/npm install failed/);
  });

  test('sandbox unavailable → completed but unverified (never "verified")', async () => {
    toolbox.execute.mockResolvedValue({ success: false, skipped: true, errors: ['Docker is not available'], tests: { total: 0, passed: 0, failed: 0, failures: [] } });
    const { taskId } = await controller.startPipeline('no docker');
    const t = await terminal(taskId);
    expect(t.status).toBe('completed');
    expect(t.finalOutput.outcome.verdict).toBe('unverified');
  });

  test('sandbox crash is caught and reported, not thrown', async () => {
    toolbox.execute.mockRejectedValue(new Error('docker daemon went away'));
    const { taskId } = await controller.startPipeline('sandbox crash');
    const t = await terminal(taskId);
    expect(t.status).toBe('failed');
  });
});

describe('controller: lifecycle', () => {
  test('cancellation mid-build → status cancelled, modules failed', async () => {
    let release;
    queue.enqueueJob.mockImplementation(async (_d, cb) => { release = () => cb(null, workerOk()); });
    const { taskId } = await controller.startPipeline('cancel me');
    await waitFor(() => queue.enqueueJob.mock.calls.length > 0);
    expect(controller.cancelPipeline(taskId)).toBe(true);
    release();
    const t = await terminal(taskId);
    expect(t.status).toBe('cancelled');
    expect(ModuleModel.docs.every((m) => m.status === 'failed')).toBe(true);
    expect(controller.cancelPipeline(taskId)).toBe(false); // nothing left to cancel
  });

  test('duplicate in-flight request returns the same task instead of starting another', async () => {
    let release;
    queue.enqueueJob.mockImplementation(async (_d, cb) => { release = () => cb(null, workerOk()); });
    const a = await controller.startPipeline('same idea twice');
    const b = await controller.startPipeline('same idea twice');
    expect(b).toMatchObject({ taskId: a.taskId, duplicate: true, status: 'already-running' });
    expect(Task.docs).toHaveLength(1);
    await waitFor(() => queue.enqueueJob.mock.calls.length > 0);
    controller.cancelPipeline(a.taskId);
    release();
    await terminal(a.taskId);
  });

  test('database failure when creating the task surfaces to the caller and leaves nothing running', async () => {
    Task._failNext = new Error('mongo down');
    await expect(controller.startPipeline('db down')).rejects.toThrow('mongo down');
    expect(controller.cancelPipeline('anything')).toBe(false);
  });
});

describe('controller: recovery after restart', () => {
  const seed = ({ modules = [], status = 'building', resumeCount = 0 } = {}) => {
    Task.docs.push({ taskId: 'T1', idea: 'interrupted idea', status, modules: modules.map((m) => m.moduleId), resumeCount, metadata: {}, createdAt: new Date(), error: null });
    modules.forEach((m) => ModuleModel.docs.push({ taskId: 'T1', dependencies: [], validationPassed: false, usedFallback: false, qualityScore: 0, ...m }));
  };
  const cfg = { moduleId: 'm-cfg', name: 'Configuration Module', description: 'config', type: 'config', priority: 0 };
  const db = { moduleId: 'm-db', name: 'Database Module', description: 'db', type: 'database', priority: 1 };

  test('resumes from persisted modules: completed work is NOT redone', async () => {
    seed({ modules: [
      { ...cfg, status: 'completed', output: CODE('cfg'), validationPassed: true, prompt: 'P1' },
      { ...db, status: 'queued', prompt: 'P2', assignedModel: 'm' },
    ] });
    const summary = await controller.recoverInterruptedPipelines();
    expect(summary.resumed).toEqual(['T1']);
    const t = await terminal('T1');
    expect(t.status).toBe('completed');
    expect(t.resumeCount).toBe(1);
    expect(queue.enqueueJob).toHaveBeenCalledTimes(1);
    expect(queue.enqueueJob.mock.calls[0][0].moduleContext.moduleId).toBe('m-db');
    expect(queue.enqueueJob.mock.calls[0][0].prompt).toBe('P2'); // reused the persisted prompt
    expect(t.finalOutput.outcome.verdict).toBe('verified');
  });

  test('task interrupted before decomposition finished → failed with an accurate reason', async () => {
    seed({ modules: [], status: 'decomposing' });
    const summary = await controller.recoverInterruptedPipelines();
    expect(summary.failed).toEqual(['T1']);
    const t = await Task.findOne({ taskId: 'T1' });
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/before decomposition finished/);
  });

  test('crash loops are bounded: too many resumes → failed', async () => {
    seed({ modules: [{ ...cfg, status: 'queued', prompt: 'P' }], resumeCount: 2 });
    await controller.recoverInterruptedPipelines();
    const t = await Task.findOne({ taskId: 'T1' });
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/repeated restarts/);
    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(ModuleModel.docs[0].status).toBe('failed');
  });

  test('PIPELINE_RESUME=false marks interrupted tasks failed instead of resuming', async () => {
    seed({ modules: [{ ...cfg, status: 'queued', prompt: 'P' }] });
    await controller.recoverInterruptedPipelines({ resume: false });
    expect((await Task.findOne({ taskId: 'T1' })).status).toBe('failed');
    expect(queue.enqueueJob).not.toHaveBeenCalled();
  });

  test('terminal tasks are left alone', async () => {
    seed({ modules: [{ ...cfg, status: 'completed', output: CODE('c') }], status: 'completed' });
    const summary = await controller.recoverInterruptedPipelines();
    expect(summary).toEqual({ resumed: [], failed: [] });
  });
});

describe('controller: human approval gate before executing generated code', () => {
  beforeEach(() => { config.pipeline.requireExecutionApproval = true; config.pipeline.approvalTimeoutMs = 2000; });
  afterEach(() => { config.pipeline.requireExecutionApproval = false; });
  const waitingFor = (id) => waitFor(async () => (await Task.findOne({ taskId: id })).status === 'awaiting-approval');

  test('pauses in awaiting-approval, executes only after approval, then completes', async () => {
    const { taskId } = await controller.startPipeline('needs a human');
    await waitingFor(taskId);
    expect(toolbox.execute).not.toHaveBeenCalled(); // nothing ran yet
    expect(controller.resolveApproval(taskId, true)).toBe(true);
    const t = await terminal(taskId);
    expect(t.status).toBe('completed');
    expect(toolbox.execute).toHaveBeenCalledTimes(1);
    expect(t.finalOutput.outcome.verdict).toBe('verified');
  });

  test('rejection → artifact kept, code never executed, verdict unverified', async () => {
    const { taskId } = await controller.startPipeline('human says no');
    await waitingFor(taskId);
    controller.resolveApproval(taskId, false);
    const t = await terminal(taskId);
    expect(toolbox.execute).not.toHaveBeenCalled();
    expect(t.status).toBe('completed');
    expect(t.finalOutput.outcome.verdict).toBe('unverified');
    expect(t.finalOutput.execution.errors[0]).toMatch(/rejected by operator/);
    expect(t.finalOutput.files.length).toBeGreaterThan(0);
  });

  test('no answer before the timeout → treated as not approved (fail closed)', async () => {
    config.pipeline.approvalTimeoutMs = 60;
    const { taskId } = await controller.startPipeline('nobody answers');
    const t = await terminal(taskId);
    expect(toolbox.execute).not.toHaveBeenCalled();
    expect(t.finalOutput.execution.errors[0]).toMatch(/timed out/);
    expect(t.finalOutput.outcome.verdict).toBe('unverified');
  });

  test('cancelling while waiting ends the task as cancelled', async () => {
    const { taskId } = await controller.startPipeline('cancel at the gate');
    await waitingFor(taskId);
    controller.cancelPipeline(taskId);
    const t = await terminal(taskId);
    expect(t.status).toBe('cancelled');
    expect(toolbox.execute).not.toHaveBeenCalled();
  });

  test('approving a task that is not waiting is a no-op', async () => {
    expect(controller.resolveApproval('nonexistent', true)).toBe(false);
  });

  test('a restart while awaiting approval resumes and asks again', async () => {
    Task.docs.push({ taskId: 'W1', idea: 'was waiting', status: 'awaiting-approval', modules: ['m-cfg'], resumeCount: 0, metadata: {}, createdAt: new Date(), error: null });
    ModuleModel.docs.push({ taskId: 'W1', moduleId: 'm-cfg', name: 'Configuration Module', description: 'c', type: 'config', priority: 0, dependencies: [], status: 'completed', output: CODE('c'), validationPassed: true, usedFallback: false, qualityScore: 90 });
    await controller.recoverInterruptedPipelines();
    await waitFor(async () => (await Task.findOne({ taskId: 'W1' })).status === 'awaiting-approval' && toolbox.execute.mock.calls.length === 0 && controller.resolveApproval('W1', true));
    expect((await terminal('W1')).status).toBe('completed');
  });
});

describe('controller: the database failing mid-run', () => {
  test('failure to persist the failure does not mask the original error or crash the process', async () => {
    queue.enqueueJob.mockImplementation(async (_d, cb) => setImmediate(() => cb(new Error('worker exploded'))));
    const original = Task.findOneAndUpdate;
    // DB goes away exactly when the failure is being recorded
    Task.findOneAndUpdate = jest.fn(async (q, update) => {
      if (update.status === 'failed') throw new Error('mongo went away');
      return original.call(Task, q, update);
    });
    try {
      const { taskId } = await controller.startPipeline('db dies at the worst time');
      await waitFor(() => Task.findOneAndUpdate.mock.calls.some(([, u]) => u.status === 'failed'));
      await sleep(50);
      // the task is left non-terminal; startup recovery will settle it
      expect((await Task.findOne({ taskId })).status).not.toBe('failed');
    } finally { Task.findOneAndUpdate = original; }

    const summary = await controller.recoverInterruptedPipelines({ resume: false });
    expect(summary.failed).toHaveLength(1);
  });
});
