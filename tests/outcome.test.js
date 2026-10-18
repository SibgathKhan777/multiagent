const { computeOutcome } = require('../src/core/outcome');

const mod = (over = {}) => ({ name: 'M', validationPassed: true, usedFallback: false, score: 90, ...over });
const okExec = { success: true, tests: { passed: 3, total: 3 } };

describe('computeOutcome', () => {
  test('verified: everything passed with a real provider', () => {
    expect(computeOutcome({ modules: [mod()], execution: okExec, provider: 'groq' })).toEqual({ verdict: 'verified', reasons: [] });
  });

  test('failed: a module exhausted retries without passing validation', () => {
    const r = computeOutcome({ modules: [mod({ name: 'Auth', validationPassed: false, score: 41 })], execution: okExec, provider: 'groq' });
    expect(r.verdict).toBe('failed');
    expect(r.reasons[0]).toMatch(/Auth \(score 41\)/);
  });

  test('failed: execution ran and failed, even though every module validated', () => {
    const r = computeOutcome({ modules: [mod()], execution: { success: false, tests: { passed: 1, total: 3 }, errors: ['2 test failure(s)'] }, provider: 'groq' });
    expect(r.verdict).toBe('failed');
    expect(r.reasons[0]).toMatch(/1\/3 tests passed/);
  });

  test('failed: LLM failure masked by a template fallback on a real provider', () => {
    const r = computeOutcome({ modules: [mod({ name: 'DB', usedFallback: true })], execution: okExec, provider: 'groq' });
    expect(r.verdict).toBe('failed');
    expect(r.reasons[0]).toMatch(/template code was substituted for: DB/);
  });

  test('unverified: sandbox unavailable is not success', () => {
    const r = computeOutcome({ modules: [mod()], execution: { skipped: true, success: false }, provider: 'groq' });
    expect(r.verdict).toBe('unverified');
  });

  test('unverified: no execution result at all', () => {
    expect(computeOutcome({ modules: [mod()], execution: undefined, provider: 'groq' }).verdict).toBe('unverified');
  });

  test('simulated provider never reaches verified, and template use is not a failure there', () => {
    const r = computeOutcome({ modules: [mod({ usedFallback: true })], execution: okExec, provider: 'simulated' });
    expect(r.verdict).toBe('unverified');
    expect(r.reasons).toEqual([expect.stringMatching(/simulated template generator/)]);
  });

  test('failed outranks unverified and reasons accumulate', () => {
    const r = computeOutcome({ modules: [mod({ validationPassed: false })], execution: { skipped: true }, provider: 'groq' });
    expect(r.verdict).toBe('failed');
    expect(r.reasons).toHaveLength(2);
  });
});
