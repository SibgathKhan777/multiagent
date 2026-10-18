const fs = require('fs');
const os = require('os');
const path = require('path');
const modelsConfig = require('../config/models');
const tasksFile = require('../evals/codegen/tasks.json');
const reference = require('../evals/codegen/reference');
const { gradeSolution, classifyRun } = require('../evals/codegen/grader');
const { runCodegenSuite, runTask, buildPrompt, retryPrompt } = require('../evals/codegen/suite');
const { makeMockProvider } = require('../evals/codegen/mockModels');
const { validateResult } = require('../evals/schema');
const { compare } = require('../evals/compare');
const { runToolsSuite, judgeSelection } = require('../evals/tools/suite');
const { mocks } = require('../evals/tools/selectors');
const { McpToolClient } = require('../evals/../src/mcp/client');

jest.setTimeout(60000);
const tasks = tasksFile.tasks;
const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));
const ids = tasks.map((t) => t.id);

let savedProvider;
beforeEach(() => { savedProvider = modelsConfig.provider; process.env.LLM_BASE_DELAY_MS = '1'; process.env.EVAL_GRADE_TIMEOUT_MS = '2000'; });
afterEach(() => { modelsConfig.provider = savedProvider; delete process.env.LLM_BASE_DELAY_MS; delete process.env.EVAL_GRADE_TIMEOUT_MS; });

const runMock = (behaviour, extra = {}) => {
  modelsConfig.provider = 'mock';
  return runCodegenSuite({ tasks, providers: { mock: makeMockProvider(behaviour, ids) }, gradeMode: 'local-trusted', ...extra });
};

describe('codegen dataset + grader', () => {
  test('every task has hidden tests and its reference solution passes all of them', async () => {
    for (const t of tasks) {
      expect(t.tests.length).toBeGreaterThanOrEqual(3);
      const g = await gradeSolution(t, reference[t.id], { mode: 'local-trusted' });
      expect({ id: t.id, status: g.status }).toEqual({ id: t.id, status: 'passed' });
    }
  });

  test('grader separates failure classes', async () => {
    const t = taskById.chunk;
    const grade = (code) => gradeSolution(t, code, { mode: 'local-trusted' });
    expect((await grade('function ((( {')).failureClass).toBe('syntax_error');
    expect((await grade('throw new Error("boom at load")')).failureClass).toBe('load_error');
    expect((await grade('module.exports = { somethingElse() {} };')).failureClass).toBe('missing_export');
    expect((await grade('module.exports = { chunk() { return []; } };')).failureClass).toBe('wrong_answer');
    expect((await grade('module.exports = { chunk() { throw new Error("always"); } };')).failureClass).toBe('runtime_error');
    expect((await grade('module.exports = { chunk() { while (true) {} } };')).failureClass).toBe('timeout');
  });

  test('a solution that never throws fails the "must throw" case, and partial credit is counted', async () => {
    const g = await gradeSolution(taskById.chunk, 'module.exports = { chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n || 1) o.push(a.slice(i, i + (n || 1))); return o; } };', { mode: 'local-trusted' });
    expect(g.status).toBe('failed');
    expect(g.failures.some((f) => f.kind === 'expected_throw')).toBe(true);
    expect(g.passedTests).toBeGreaterThan(0);
    expect(g.passedTests).toBeLessThan(g.totalTests);
  });

  test('docker mode: sandbox unavailable is its own class, never a pass or a host run', async () => {
    const runner = jest.fn(async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }));
    const g = await gradeSolution(taskById.chunk, reference.chunk, { mode: 'docker', runner });
    expect(g).toMatchObject({ executed: false, status: 'sandbox_unavailable' });
    expect(runner).toHaveBeenCalledTimes(1); // just the `docker info` probe
  });

  test('docker mode runs the grader in a locked-down container', async () => {
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push(args);
      if (args[0] === 'info') return { code: 0, stdout: '', stderr: '', timedOut: false };
      return { code: 0, timedOut: false, stdout: '__GRADE__' + JSON.stringify({ status: 'ran', results: taskById.chunk.tests.map((_, i) => ({ index: i, pass: true })) }) + '\n' };
    };
    const g = await gradeSolution(taskById.chunk, reference.chunk, { mode: 'docker', runner });
    expect(g.status).toBe('passed');
    const run = calls.find((a) => a[0] === 'run');
    expect(run[run.indexOf('--network') + 1]).toBe('none');
    expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--read-only']));
  });

  test('unknown grading mode is rejected', async () => {
    await expect(gradeSolution(taskById.chunk, 'x', { mode: 'yolo' })).rejects.toThrow(/Unknown grading mode/);
  });

  test('prompts: only the first test is shown; retry prompt carries failing cases', () => {
    const p = buildPrompt(taskById.slugify);
    expect(p).toContain('"Hello World!"');
    expect(p).not.toContain('caf-m-nster'); // hidden case
    const r = retryPrompt(taskById.slugify, 'old code', classifyRun(taskById.slugify, { status: 'ran', results: [{ index: 3, pass: false, kind: 'wrong_answer', got: 'x' }] }));
    expect(r).toContain('expected ""');
    expect(r).toContain('old code');
  });
});

describe('codegen suite (deterministic mock mode)', () => {
  test('mixed behaviour yields exact, hand-computed numbers with denominators', async () => {
    const { summary, failedCases } = await runMock('mixed');
    // 20 tasks cycle perfect, flaky, wrong, broken, perfect: 8 perfect, 4 flaky (recover on retry), 4 wrong, 4 broken
    expect(summary.denominators).toEqual({ tasks: 20, graded: 20, providerErrors: 0, sandboxUnavailable: 0, failedFirstAttempt: 12, testCases: expect.any(Number) });
    expect(summary.taskSuccessRate).toBeCloseTo(12 / 20);
    expect(summary.firstAttemptSuccessRate).toBeCloseTo(8 / 20);
    expect(summary.retryRecoveryRate).toBeCloseTo(4 / 12);
    expect(summary.failureClasses).toEqual({ wrong_answer: 4, syntax_error: 4 });
    expect(summary.structuredOutputValidity).toBeCloseTo(16 / 20);
    expect(failedCases).toHaveLength(8);
    expect(summary.totalEstimatedCostUsd).toBeNull(); // mock has no real prices → no invented cost
  });

  test('perfect model: everything passes first time, nothing to recover', async () => {
    const { summary } = await runMock('perfect');
    expect(summary.taskSuccessRate).toBe(1);
    expect(summary.firstAttemptSuccessRate).toBe(1);
    expect(summary.retryRecoveryRate).toBeNull(); // no first-attempt failures → undefined, not 100%
    expect(summary.failureClasses).toEqual({});
  });

  test('broken model: failures are classified, retries do not help', async () => {
    const { summary } = await runMock('broken');
    expect(summary.taskSuccessRate).toBe(0);
    expect(summary.failureClasses).toEqual({ syntax_error: tasks.length });
    expect(summary.retryRecoveryRate).toBe(0);
  });

  test('provider outage is counted as provider errors and excluded from the success denominator', async () => {
    const { summary, results } = await runMock('outage');
    expect(summary.denominators).toMatchObject({ tasks: tasks.length, graded: 0, providerErrors: tasks.length });
    expect(summary.taskSuccessRate).toBeNull();
    expect(summary.taskSuccessRateOverall).toBe(0);
    expect(summary.providerErrorRate).toBe(1);
    expect(results[0].attempts[0]).toMatchObject({ classification: 'provider_error', providerErrorKind: 'transient' });
  });

  test('empty responses are provider errors (retried by the worker), not graded as code', async () => {
    const { summary, results } = await runMock('empty');
    expect(summary.denominators.providerErrors).toBe(tasks.length);
    expect(results[0].attempts[0].providerErrorKind).toBe('empty_response');
  });

  test('sandbox down is reported separately, not as failures', async () => {
    modelsConfig.provider = 'mock';
    const runner = async () => ({ code: 1, stdout: '', stderr: '', timedOut: false });
    const { summary } = await runCodegenSuite({
      tasks: tasks.slice(0, 3), providers: { mock: makeMockProvider('perfect', ids) }, gradeMode: 'docker',
      grade: (t, c, o) => gradeSolution(t, c, { ...o, runner }),
    });
    expect(summary.denominators).toMatchObject({ tasks: 3, graded: 0, sandboxUnavailable: 3 });
    expect(summary.taskSuccessRate).toBeNull();
  });

  test('early stop callback halts the run', async () => {
    modelsConfig.provider = 'mock';
    let n = 0;
    const out = await runCodegenSuite({ tasks, providers: { mock: makeMockProvider('perfect', ids) }, gradeMode: 'local-trusted', onTask: () => ++n === 2 });
    expect(out.results).toHaveLength(2);
  });

  test('the full report passes schema validation; tampering is caught', async () => {
    const { summary, results, failedCases } = await runMock('mixed');
    const report = { schemaVersion: 1, suite: 'codegen', mode: 'mock', label: 't', createdAt: new Date().toISOString(), config: { provider: 'mock', datasetHash: 'abc' }, summary, results, failedCases };
    expect(validateResult(report)).toEqual([]);
    expect(validateResult({ ...report, summary: { ...summary, taskSuccessRate: 1.5 } }).join()).toMatch(/within \[0,1\]/);
    expect(validateResult({ ...report, summary: { ...summary, denominators: { ...summary.denominators, tasks: 3 } } }).join()).toMatch(/tasks must equal results.length/);
    expect(validateResult({ ...report, config: { provider: 'groq', datasetHash: 'abc' } }).join()).toMatch(/mock results must declare provider "mock"/);
    expect(validateResult({ ...report, summary: { rate: 1 } }).join()).toMatch(/denominators required/);
  });

  test('compare gates codegen regressions and refuses mixed suites/modes', async () => {
    const good = (await runMock('perfect'));
    const bad = (await runMock('broken'));
    const wrap = (o, over = {}) => ({ suite: 'codegen', mode: 'mock', config: { provider: 'mock', datasetHash: 'h' }, summary: o.summary, ...over });
    const r = compare(wrap(good), wrap(bad));
    expect(r.ok).toBe(false);
    expect(r.regressions).toEqual(expect.arrayContaining(['taskSuccessRate', 'testCasePassRate']));
    expect(compare(wrap(good), wrap(good)).ok).toBe(true);
    expect(compare(wrap(good), wrap(good, { suite: 'tools' })).problems.join()).toMatch(/suite differs/);
    expect(compare(wrap(good), wrap(good, { mode: 'live' })).problems.join()).toMatch(/mock and live/);
  });
});

describe('retry recovery with real failing cases', () => {
  test('attempt 2 receives the failing hidden case and can fix the code', async () => {
    modelsConfig.provider = 'mock';
    const prompts = [];
    const provider = (prompt, _t, ctx) => {
      prompts.push(prompt);
      return { code: ctx.iteration === 0 ? 'module.exports = { slugify() { return "x"; } };' : reference.slugify, usage: null, model: 'mock' };
    };
    const r = await runTask(taskById.slugify, { providers: { mock: provider }, gradeMode: 'local-trusted', maxAttempts: 2 });
    expect(r).toMatchObject({ success: true, recoveredByRetry: true });
    expect(prompts[1]).toMatch(/Failing cases/);
    expect(prompts[1]).toContain('slugify(');
  });
});

describe('tool-selection suite (real MCP server + client)', () => {
  const scenarios = require('../evals/tools/scenarios.json').scenarios;
  let workspace; let client;
  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'toolseval-test-'));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'README.md'), '# demo');
    fs.writeFileSync(path.join(workspace, 'src/app.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(workspace, 'src/utils.js'), 'module.exports = {};');
    process.env.VALIDATOR_RUNTIME = 'off'; // keep validate_code off Docker in tests
    client = await new McpToolClient({ workspace }).connect();
  });
  afterAll(async () => { await client.close(); fs.rmSync(workspace, { recursive: true, force: true }); delete process.env.VALIDATOR_RUNTIME; });

  test('judgeSelection covers each outcome', () => {
    const s = { acceptable: ['read_project_file'], expectArgs: { path: 'a' } };
    expect(judgeSelection(s, { tool: 'read_project_file', args: { path: 'a' } })).toMatchObject({ correct: true });
    expect(judgeSelection(s, { tool: 'read_project_file', args: { path: 'b' } }).kind).toBe('wrong_arguments');
    expect(judgeSelection(s, { tool: 'list_project_files', args: {} }).kind).toBe('wrong_tool');
    expect(judgeSelection(s, { tool: null }).kind).toBe('missed_call');
    expect(judgeSelection({ acceptable: [] }, { tool: 'x' }).kind).toBe('unnecessary_call');
    expect(judgeSelection({ acceptable: [] }, { tool: null }).kind).toBe('correct_no_call');
    expect(judgeSelection({ acceptable: ['read_project_file'], acceptNoCall: true }, { tool: null })).toEqual({ correct: true, kind: 'correct_refusal' });
  });

  test('oracle: perfect selection, valid args, and the workspace guardrail holds', async () => {
    const { summary } = await runToolsSuite({ scenarios, select: mocks.oracle, client });
    expect(summary.denominators).toMatchObject({ scenarios: 12, answered: 12, toolCalls: 9, guardrailScenarios: 2 });
    expect(summary.toolSelectionAccuracy).toBe(1);
    expect(summary.toolExecutionSuccessRate).toBe(1);
    expect(summary.guardrailHoldRate).toBe(1); // /etc/passwd and ../ attempts were refused by the server
    expect(summary.unnecessaryCallRate).toBe(0);
  });

  test('naive selector is measured as bad, with classified failures', async () => {
    const { summary } = await runToolsSuite({ scenarios, select: mocks.naive, client });
    expect(summary.toolSelectionAccuracy).toBeCloseTo(2 / 12);
    expect(summary.unnecessaryCallRate).toBe(1);
    expect(summary.failureClasses).toMatchObject({ unnecessary_call: 3, wrong_tool: 6 });
    expect(summary.guardrailHoldRate).toBeNull(); // it never attempted an escape → nothing to measure
  });

  test('never-calling selector misses every needed call but never makes unnecessary ones', async () => {
    const { summary } = await runToolsSuite({ scenarios, select: mocks.never, client });
    // the two path-escape scenarios accept a refusal, so they are not misses
    expect(summary.failureClasses).toEqual({ missed_call: 7 });
    expect(summary.unnecessaryCallRate).toBe(0);
    expect(summary.toolCallPrecision).toBeNull();
  });

  test('sloppy selector: invalid arguments and hallucinated tools are caught', async () => {
    const { results, summary } = await runToolsSuite({ scenarios, select: mocks.sloppy, client });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['validate-inline'].execution).toMatchObject({ ok: false, invalidArguments: true });
    expect(byId.destructive).toMatchObject({ chosen: 'delete_files', discovered: false });
    expect(byId.destructive.execution.ok).toBe(false);
    expect(summary.argumentValidityRate).toBeLessThan(1);
  });

  test('provider errors are separated from wrong answers', async () => {
    const select = async () => { const e = new Error('rate limited'); e.llm = { kind: 'rate_limit' }; throw e; };
    const { summary } = await runToolsSuite({ scenarios: scenarios.slice(0, 3), select, client });
    expect(summary.denominators).toMatchObject({ scenarios: 3, answered: 0, providerErrors: 3 });
    expect(summary.toolSelectionAccuracy).toBeNull();
  });
});
