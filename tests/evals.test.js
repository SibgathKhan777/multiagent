const dataset = require('../evals/dataset.json');
const { scoreDecomposition, requirementCoverage, aggregate, MODULE_NAMES } = require('../evals/metrics');
const { compare } = require('../evals/compare');
const { runTask } = require('../evals/harness');

describe('dataset', () => {
  test('is well-formed with unique ids and valid module keys', () => {
    const ids = new Set();
    for (const t of dataset.tasks) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.idea.length).toBeGreaterThan(10);
      for (const k of [...t.expect, ...t.forbid]) expect(MODULE_NAMES[k]).toBeDefined();
      expect(t.expect.filter((k) => t.forbid.includes(k))).toEqual([]);
      expect(t.mustMention.length).toBeGreaterThan(0);
    }
    expect(dataset.tasks.length).toBeGreaterThanOrEqual(30);
  });
});

describe('metrics', () => {
  const task = { expect: ['database', 'payment'], forbid: ['upload'], mustMention: ['order', 'refund'] };

  test('scoreDecomposition: recall, missing, forbidden', () => {
    const r = scoreDecomposition(task, ['Database Module', 'File Upload Module']);
    expect(r.recall).toBe(0.5);
    expect(r.missing).toEqual(['Payment Module']);
    expect(r.forbiddenHits).toEqual(['File Upload Module']);
    expect(r.clean).toBe(0);
  });

  test('requirementCoverage is case-insensitive', () => {
    expect(requirementCoverage(task, ['const Order = 1;'])).toBe(0.5);
    expect(requirementCoverage(task, ['order refund'])).toBe(1);
  });

  test('aggregate computes rates and ignores errored tasks', () => {
    const ok = (success, passed, total, firstPass) => ({
      decomposition: { recall: 1, clean: 1 }, coverage: 1, latencyMs: 100, tokens: { input: 10, output: 20 },
      modules: [{ firstPassPassed: firstPass, passed: true, score: 80, iterations: 1, invalid: false, fallback: false }],
      sandbox: { skipped: false, success, testsPassed: passed, testsTotal: total },
    });
    const s = aggregate([ok(true, 2, 2, true), ok(false, 1, 2, false), { error: 'boom' }]);
    expect(s.errored).toBe(1);
    expect(s.taskCompletionRate).toBe(0.5);
    expect(s.testPassRate).toBe(0.75);
    expect(s.firstPassValidatorRate).toBe(0.5);
    expect(s.avgInputTokens).toBe(10);
  });

  test('aggregate reports null (not 0) when the sandbox never ran', () => {
    const r = { decomposition: { recall: 1, clean: 1 }, coverage: 1, latencyMs: 1, tokens: null, modules: [], sandbox: { skipped: true } };
    const s = aggregate([r]);
    expect(s.taskCompletionRate).toBeNull();
    expect(s.testPassRate).toBeNull();
    expect(s.avgInputTokens).toBeNull();
  });
});

describe('compare (regression gate)', () => {
  const mk = (over = {}, meta = {}) => ({ datasetHash: 'h', provider: 'groq', summary: { requirementCoverage: 0.8, taskCompletionRate: 0.5, invalidOutputRate: 0.1, avgLatencyMs: 1000, ...over }, ...meta });

  test('passes on improvement', () => {
    const r = compare(mk(), mk({ taskCompletionRate: 0.7 }));
    expect(r.ok).toBe(true);
    expect(r.rows.find((x) => x.metric === 'taskCompletionRate').status).toBe('better');
  });
  test('flags quality drops beyond tolerance, ignores noise within it', () => {
    expect(compare(mk(), mk({ taskCompletionRate: 0.4 })).regressions).toEqual(['taskCompletionRate']);
    expect(compare(mk(), mk({ taskCompletionRate: 0.49 })).ok).toBe(true);
  });
  test('flags lower-is-better metrics rising', () => {
    expect(compare(mk(), mk({ invalidOutputRate: 0.3 })).regressions).toEqual(['invalidOutputRate']);
  });
  test('latency is reported but never gates', () => {
    const r = compare(mk(), mk({ avgLatencyMs: 9000 }));
    expect(r.ok).toBe(true);
    expect(r.rows.find((x) => x.metric === 'avgLatencyMs').status).toBe('worse');
  });
  test('refuses to compare different datasets or providers', () => {
    expect(compare(mk(), mk({}, { datasetHash: 'other' })).ok).toBe(false);
    expect(compare(mk(), mk({}, { provider: 'gemini' })).ok).toBe(false);
  });
});

describe('harness with stubbed agents', () => {
  const task = { id: 'x', idea: 'demo', expect: ['database'], forbid: [], mustMention: ['widget'] };
  const mods = [{ name: 'Database Module', description: 'd', type: 'database', dependencies: [] }];
  const baseDeps = (over = {}) => ({
    maxIterations: 3,
    getFilePath: () => 'src/x.js',
    decompose: async () => mods,
    generatePrompt: async () => ({ prompt: 'P', model: 'm' }),
    executeWork: async () => ({ code: 'module.exports = { widget };', usage: { input: 5, output: 7 }, fallback: false }),
    validate: async () => ({ passed: true, score: 90, issues: [] }),
    generateFeedback: async () => ({ refinedPrompt: 'P2' }),
    integrate: async () => ({ files: [] }),
    execute: async () => ({ success: true, tests: { total: 2, passed: 2, failures: [] } }),
    ...over,
  });

  test('records first-pass success, tokens, coverage and sandbox result', async () => {
    const r = await runTask(task, { deps: baseDeps() });
    expect(r.modules[0]).toMatchObject({ firstPassPassed: true, passed: true, iterations: 1 });
    expect(r.tokens).toEqual({ input: 5, output: 7 });
    expect(r.coverage).toBe(1);
    expect(r.sandbox).toMatchObject({ success: true, testsPassed: 2 });
    expect(r.modules[0].code).toBeUndefined();
  });

  test('retries via feedback and distinguishes first-pass from final pass', async () => {
    let n = 0;
    const r = await runTask(task, { deps: baseDeps({
      validate: async () => (++n < 2 ? { passed: false, score: 40, issues: [{ type: 'error', message: 'Syntax error: x', severity: 9 }] } : { passed: true, score: 85, issues: [] }),
    }) });
    expect(r.modules[0]).toMatchObject({ firstPassPassed: false, passed: true, iterations: 2 });
  });

  test('marks invalid output and fallback usage; stops at max iterations', async () => {
    const r = await runTask(task, { deps: baseDeps({
      executeWork: async () => ({ code: 'x', fallback: true, usage: null }),
      validate: async () => ({ passed: false, score: 0, issues: [{ type: 'error', message: 'Code is empty or too short', severity: 10 }] }),
    }) });
    expect(r.modules[0]).toMatchObject({ passed: false, invalid: true, fallback: true, iterations: 3 });
    expect(r.tokens).toBeNull();
  });

  test('skips sandbox when disabled', async () => {
    const r = await runTask(task, { sandbox: false, deps: baseDeps({ execute: async () => { throw new Error('should not run'); } }) });
    expect(r.sandbox).toBeNull();
  });
});
