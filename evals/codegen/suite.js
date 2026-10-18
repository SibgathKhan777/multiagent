'use strict';

/**
 * Codegen eval suite: for each task, ask a model for a function, grade it with
 * hidden executable tests, and on failure give it the failing cases for one more try.
 * The model call goes through the real worker (timeouts, classified retries,
 * fallback accounting), so provider failures are measured, not hidden.
 */

const { executeWork } = require('../../src/agents/worker');
const { gradeSolution } = require('./grader');
const tracer = require('../../src/observability/tracer');

function buildPrompt(task) {
  const ex = task.tests[0];
  const example = ex.throws ? `${task.export}(${ex.args.map((a) => JSON.stringify(a)).join(', ')}) throws an Error` : `${task.export}(${ex.args.map((a) => JSON.stringify(a)).join(', ')}) -> ${JSON.stringify(ex.expect)}`;
  return [
    'Implement the following JavaScript function (Node.js, CommonJS, no external packages).',
    `Requirements: ${task.requirements}`,
    `Example: ${example}`,
    `Export it exactly like: module.exports = { ${task.export} };`,
    'Return ONLY the code, with no markdown fences and no explanation.',
  ].join('\n');
}

function retryPrompt(task, previousCode, grade) {
  const cases = (grade.failures || []).slice(0, 3).map((f) => {
    const call = `${task.export}(${f.args.map((a) => JSON.stringify(a)).join(', ')})`;
    return `- ${call}: expected ${JSON.stringify(f.expected)}, got ${f.error ? `error "${f.error}"` : JSON.stringify(f.got)}`;
  });
  const why = grade.message ? `Problem: ${grade.message}` : `Failing cases:\n${cases.join('\n')}`;
  return `${buildPrompt(task)}\n\nYour previous attempt was wrong.\n${why}\n\nPrevious code:\n${previousCode.slice(0, 3000)}\n\nReturn the corrected, complete code only.`;
}

async function runTask(task, { providers, gradeMode, maxAttempts, workerDeps = {}, grade = gradeSolution, gradeOptions = {} }) {
  const attempts = [];
  let prompt = buildPrompt(task);
  let lastCode = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const started = Date.now();
    let work;
    try {
      work = await executeWork(
        { prompt, model: 'eval', moduleContext: { name: task.id, type: 'utilities', description: task.requirements, dependencies: [], iteration: attempt } },
        { providers, ...workerDeps },
      );
    } catch (err) {
      attempts.push({ attempt, generationMode: 'error', classification: 'provider_error', providerErrorKind: err.llm?.kind || 'unknown', latencyMs: Date.now() - started, passedTests: 0, totalTests: task.tests.length });
      break;
    }

    const base = { attempt, generationMode: work.generation.mode, latencyMs: Date.now() - started, usage: work.usage || null, estimatedCostUsd: work.generation.estimatedCostUsd ?? null, generationAttempts: work.generation.attempts };

    // A substituted template is not model output: record the provider failure, don't grade it
    if (work.generation.mode === 'fallback-template') {
      attempts.push({ ...base, classification: 'provider_error', providerErrorKind: work.generation.fallbackReason?.kind || 'unknown', passedTests: 0, totalTests: task.tests.length });
      break;
    }

    const g = await grade(task, work.code, { mode: gradeMode, ...gradeOptions });
    attempts.push({
      ...base,
      classification: g.status === 'passed' ? 'passed' : g.failureClass,
      passedTests: g.passedTests, totalTests: g.totalTests,
      failures: (g.failures || []).slice(0, 3),
      message: g.message,
      executed: g.executed,
    });
    lastCode = work.code;
    if (g.status === 'passed' || g.status === 'sandbox_unavailable') break;
    prompt = retryPrompt(task, lastCode, g);
  }

  const final = attempts[attempts.length - 1];
  return {
    id: task.id,
    category: task.category,
    attempts,
    success: final.classification === 'passed',
    finalClass: final.classification,
    recoveredByRetry: final.classification === 'passed' && attempts.length > 1,
  };
}

const ratio = (num, den) => (den ? num / den : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarize(results) {
  const providerErrors = results.filter((r) => r.finalClass === 'provider_error');
  const sandboxDown = results.filter((r) => r.finalClass === 'sandbox_unavailable');
  const graded = results.filter((r) => !['provider_error', 'sandbox_unavailable'].includes(r.finalClass));
  const firstFailed = graded.filter((r) => r.attempts[0].classification !== 'passed');
  const finals = graded.map((r) => r.attempts[r.attempts.length - 1]);
  const allAttempts = results.flatMap((r) => r.attempts);
  const withUsage = allAttempts.filter((a) => a.usage);
  const costs = allAttempts.map((a) => a.estimatedCostUsd).filter((c) => c != null);

  const classes = {};
  for (const r of results) if (!r.success) classes[r.finalClass] = (classes[r.finalClass] || 0) + 1;

  return {
    denominators: {
      tasks: results.length,
      graded: graded.length,
      providerErrors: providerErrors.length,
      sandboxUnavailable: sandboxDown.length,
      failedFirstAttempt: firstFailed.length,
      testCases: finals.reduce((a, f) => a + f.totalTests, 0),
    },
    taskSuccessRate: ratio(graded.filter((r) => r.success).length, graded.length),
    taskSuccessRateOverall: ratio(results.filter((r) => r.success).length, results.length),
    firstAttemptSuccessRate: ratio(graded.filter((r) => r.attempts[0].classification === 'passed').length, graded.length),
    retryRecoveryRate: ratio(firstFailed.filter((r) => r.recoveredByRetry).length, firstFailed.length),
    testCasePassRate: ratio(finals.reduce((a, f) => a + f.passedTests, 0), finals.reduce((a, f) => a + f.totalTests, 0)),
    // loaded + exported the requested function (i.e. the structured output was usable)
    structuredOutputValidity: ratio(finals.filter((f) => !['syntax_error', 'load_error', 'missing_export'].includes(f.classification)).length, graded.length),
    providerErrorRate: ratio(providerErrors.length, results.length),
    failureClasses: classes,
    avgLatencyMs: mean(results.map((r) => r.attempts.reduce((a, x) => a + x.latencyMs, 0))),
    avgInputTokens: withUsage.length ? mean(withUsage.map((a) => a.usage.input)) : null,
    avgOutputTokens: withUsage.length ? mean(withUsage.map((a) => a.usage.output)) : null,
    totalEstimatedCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

async function runCodegenSuite({ tasks, providers, gradeMode, maxAttempts = 2, workerDeps, grade, gradeOptions, onTask = () => {} }) {
  const results = [];
  for (const task of tasks) {
    const r = await tracer.span(`eval:${task.id}`, { metadata: { category: task.category } }, async (h) => {
      const out = await runTask(task, { providers, gradeMode, maxAttempts, workerDeps, grade, gradeOptions });
      h.setOutput({ success: out.success, class: out.finalClass, attempts: out.attempts.length, recoveredByRetry: out.recoveredByRetry });
      return out;
    });
    results.push(r);
    if (onTask(r) === true) break; // caller asked to stop early (e.g. non-recoverable provider error)
  }
  return { results, summary: summarize(results), failedCases: results.filter((r) => !r.success).map((r) => ({ id: r.id, class: r.finalClass })) };
}

module.exports = { runCodegenSuite, runTask, summarize, buildPrompt, retryPrompt };
