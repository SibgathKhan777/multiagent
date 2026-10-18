const modelsConfig = require('../config/models');
const { executeWork } = require('../src/agents/worker');
const { classifyError, callWithRetry, parseRetryAfterMs } = require('../src/services/llmErrors');
const { redact } = require('../src/utils/redact');

const ctx = { name: 'Config', type: 'config', description: 'cfg', dependencies: [], iteration: 0 };
const GOOD = { code: "'use strict';\nmodule.exports = { a: 1 };\n// padding to exceed the minimum length", usage: { input: 10, output: 20 }, model: 'm' };
const err = (message, status) => Object.assign(new Error(message), { status });
const noSleep = async () => {};

let savedProvider;
beforeEach(() => { savedProvider = modelsConfig.provider; modelsConfig.provider = 'groq'; process.env.LLM_BASE_DELAY_MS = '1'; });
afterEach(() => {
  modelsConfig.provider = savedProvider;
  for (const k of ['LLM_FALLBACK', 'LLM_MAX_ATTEMPTS', 'LLM_TIMEOUT_MS', 'LLM_BASE_DELAY_MS', 'LLM_PRICE_IN_PER_MTOK', 'LLM_PRICE_OUT_PER_MTOK']) delete process.env[k];
});

const run = (providerFn, extra = {}) => executeWork({ prompt: 'p', model: 'm', moduleContext: ctx }, { providers: { groq: providerFn }, sleep: noSleep, ...extra });

describe('classifyError', () => {
  test.each([
    [err('boom', 503), 'transient', true],
    [err('Rate limit, try again in 2.5s', 429), 'rate_limit', true],
    [err('429 tokens per day (TPD): Limit 200000. try again in 11m10s', 429), 'quota', false],
    [err('model_not_found', 404), 'config', false],
    [err('bad key', 401), 'auth', false],
    [err('invalid', 400), 'bad_request', false],
    [Object.assign(new Error('x'), { name: 'LlmTimeoutError' }), 'timeout', true],
    [new Error('fetch failed'), 'transient', true],
  ])('%s → %s (retryable=%s)', (e, kind, retryable) => {
    expect(classifyError(e)).toMatchObject({ kind, retryable });
  });
  test('parses retry-after hints', () => {
    expect(parseRetryAfterMs(new Error('try again in 11m10.5s'))).toBe(670500);
    expect(parseRetryAfterMs(new Error('try again in 2s'))).toBe(2000);
  });
});

describe('callWithRetry', () => {
  test('stops after maxAttempts for retryable errors', async () => {
    const fn = jest.fn().mockRejectedValue(err('x', 503));
    await expect(callWithRetry(fn, { maxAttempts: 3, sleep: noSleep })).rejects.toMatchObject({ llm: { kind: 'transient', attempts: 3 } });
    expect(fn).toHaveBeenCalledTimes(3);
  });
  test('never retries permanent errors', async () => {
    const fn = jest.fn().mockRejectedValue(err('model_not_found', 404));
    await expect(callWithRetry(fn, { maxAttempts: 5, sleep: noSleep })).rejects.toMatchObject({ llm: { kind: 'config', attempts: 1 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  test('caps the wait and honours retry-after within the cap', async () => {
    const waits = [];
    const fn = jest.fn().mockRejectedValueOnce(err('try again in 3s', 429)).mockResolvedValue('ok');
    await callWithRetry(fn, { sleep: async (ms) => waits.push(ms), maxRetryWaitMs: 5000 });
    expect(waits[0]).toBeGreaterThanOrEqual(3000);
    expect(waits[0]).toBeLessThanOrEqual(5000);
  });
  test('times out a hung request', async () => {
    const fn = () => new Promise(() => {});
    await expect(callWithRetry(fn, { maxAttempts: 1, timeoutMs: 20, sleep: noSleep })).rejects.toMatchObject({ llm: { kind: 'timeout' } });
  });
});

describe('executeWork', () => {
  test('success is recorded as mode=llm with usage and attempts', async () => {
    const r = await run(async () => GOOD);
    expect(r).toMatchObject({ fallback: false, simulated: false, usage: { input: 10, output: 20 } });
    expect(r.generation).toMatchObject({ mode: 'llm', provider: 'groq', attempts: 1, model: 'm' });
    expect(r.generation.estimatedCostUsd).toBeNull(); // no prices configured → no invented cost
  });

  test('cost is computed only from operator-supplied prices', async () => {
    process.env.LLM_PRICE_IN_PER_MTOK = '1'; process.env.LLM_PRICE_OUT_PER_MTOK = '2';
    const r = await run(async () => GOOD);
    expect(r.generation.estimatedCostUsd).toBeCloseTo((10 * 1 + 20 * 2) / 1e6);
  });

  test('transient failure then success: retried, not a fallback', async () => {
    const fn = jest.fn().mockRejectedValueOnce(err('upstream', 502)).mockResolvedValue(GOOD);
    const r = await run(fn);
    expect(r.fallback).toBe(false);
    expect(r.generation.attempts).toBe(2);
  });

  test('permanent config error → one attempt, fallback template with reason recorded', async () => {
    const fn = jest.fn().mockRejectedValue(err('model_not_found', 404));
    const r = await run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ fallback: true, simulated: false });
    expect(r.generation).toMatchObject({ mode: 'fallback-template', fallbackReason: { kind: 'config' } });
    expect(r.explanation).toMatch(/Fallback to simulated template/);
  });

  test('daily quota is not retried', async () => {
    const fn = jest.fn().mockRejectedValue(err('429 tokens per day (TPD) try again in 11m', 429));
    const r = await run(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.generation.fallbackReason.kind).toBe('quota');
  });

  test.each([['empty', { code: '' }], ['whitespace', { code: '   \n ' }], ['too short', { code: 'x=1' }]])('malformed response (%s) is retried then falls back', async (_n, bad) => {
    const fn = jest.fn().mockResolvedValue(bad);
    const r = await run(fn);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(r.generation).toMatchObject({ mode: 'fallback-template', fallbackReason: { kind: 'empty_response' } });
  });

  test('hung provider times out and falls back', async () => {
    process.env.LLM_TIMEOUT_MS = '20'; process.env.LLM_MAX_ATTEMPTS = '2';
    const r = await run(() => new Promise(() => {}));
    expect(r.generation).toMatchObject({ mode: 'fallback-template', attempts: 2, fallbackReason: { kind: 'timeout' } });
  });

  test('LLM_FALLBACK=off throws instead of substituting templates', async () => {
    process.env.LLM_FALLBACK = 'off';
    await expect(run(async () => { throw err('model_not_found', 404); })).rejects.toMatchObject({ llm: { kind: 'config' } });
  });

  test('unknown provider is a permanent config error', async () => {
    modelsConfig.provider = 'nope';
    const r = await executeWork({ prompt: 'p', model: 'm', moduleContext: ctx }, { providers: {}, sleep: noSleep });
    expect(r.generation.fallbackReason.kind).toBe('config');
  });

  test('simulated provider is labelled simulated, not fallback', async () => {
    modelsConfig.provider = 'simulated';
    const r = await executeWork({ prompt: 'p', model: 'm', moduleContext: ctx });
    expect(r).toMatchObject({ simulated: true, fallback: false });
    expect(r.generation.mode).toBe('simulated');
  });

  test('secrets in provider errors never reach the result', async () => {
    const key = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
    const r = await run(async () => { throw err(`401 invalid key ${key}`, 401); });
    const dump = JSON.stringify(r);
    expect(dump).not.toContain(key);
    expect(dump).toContain('[REDACTED]');
  });
});

describe('redact', () => {
  test('masks key shapes and known secret env values', () => {
    expect(redact('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('[REDACTED]');
    expect(redact('token=abcdef123456')).toBe('token=[REDACTED]');
    expect(redact('hello MYSECRETVALUE99 world', { SOME_API_KEY: 'MYSECRETVALUE99' })).toBe('hello [REDACTED] world');
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });
});

describe('extractCode (regression: function-first output was truncated)', () => {
  const { extractCode } = require('../src/agents/worker');
  const fn = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };';

  test.each([
    ['function declaration first', fn, fn],
    ['async function first', 'async function f() { return 1; }\nmodule.exports = { f };', 'async function f() { return 1; }\nmodule.exports = { f };'],
    ['class first', 'class A {}\nmodule.exports = { A };', 'class A {}\nmodule.exports = { A };'],
    ['use strict first', "'use strict';\nconst x = 1;\nmodule.exports = { x };", "'use strict';\nconst x = 1;\nmodule.exports = { x };"],
    ['prose then fenced block', 'Here you go:\n```javascript\n' + fn + '\n```\nHope it helps!', fn],
    ['fence without language', '```\n' + fn + '\n```', fn],
    ['prose then bare code', 'Sure! Here is the code:\n\n' + fn, fn],
    ['unterminated fence (truncated reply)', '```js\n' + fn, fn],
    ['IIFE first', '(function () {})();\nmodule.exports = {};', '(function () {})();\nmodule.exports = {};'],
  ])('%s', (_name, input, expected) => {
    expect(extractCode(input)).toBe(expected);
  });

  test('empty / nullish input', () => {
    expect(extractCode('')).toBe('');
    expect(extractCode(null)).toBe('');
  });
});
