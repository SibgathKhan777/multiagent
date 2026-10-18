'use strict';

/**
 * Eval metrics — pure functions, no I/O, no LLM calls.
 */

// Decomposer module keys → module names it emits
const MODULE_NAMES = {
  config: 'Configuration Module',
  database: 'Database Module',
  api: 'API Routes Module',
  middleware: 'Middleware Module',
  authentication: 'Authentication Module',
  'real-time': 'Real-time Module',
  payment: 'Payment Module',
  notification: 'Notification Module',
  search: 'Search Module',
  upload: 'File Upload Module',
  cache: 'Caching Module',
};

/** Recall of expected modules and count of forbidden modules that were produced. */
function scoreDecomposition(task, producedNames) {
  const got = new Set(producedNames);
  const expected = task.expect.map((k) => MODULE_NAMES[k]);
  const forbidden = (task.forbid || []).map((k) => MODULE_NAMES[k]);
  const hit = expected.filter((n) => got.has(n));
  const forbiddenHits = forbidden.filter((n) => got.has(n));
  return {
    recall: expected.length ? hit.length / expected.length : 1,
    missing: expected.filter((n) => !got.has(n)),
    forbiddenHits,
    // 1 when no forbidden module was produced, 0 otherwise (per-task precision signal)
    clean: forbiddenHits.length === 0 ? 1 : 0,
  };
}

/** Fraction of required keywords present anywhere in the generated code. */
function requirementCoverage(task, codeBlobs) {
  const kws = task.mustMention || [];
  if (!kws.length) return 1;
  const text = codeBlobs.join('\n').toLowerCase();
  return kws.filter((k) => text.includes(k.toLowerCase())).length / kws.length;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (xs) => mean(xs.map((x) => (x ? 1 : 0)));

/**
 * Aggregate per-task results into a summary.
 * Each result: { decomposition, modules[], coverage, sandbox, latencyMs, tokens, error? }
 */
function aggregate(results) {
  const ok = results.filter((r) => !r.error);
  const modules = ok.flatMap((r) => r.modules);
  const sandboxRan = ok.filter((r) => r.sandbox && !r.sandbox.skipped);
  const totalTests = sandboxRan.reduce((a, r) => a + r.sandbox.testsTotal, 0);
  const passedTests = sandboxRan.reduce((a, r) => a + r.sandbox.testsPassed, 0);
  const tokensKnown = ok.filter((r) => r.tokens);

  return {
    tasks: results.length,
    errored: results.length - ok.length,
    // Decomposition (module selection)
    decompositionRecall: mean(ok.map((r) => r.decomposition.recall)),
    decompositionCleanRate: mean(ok.map((r) => r.decomposition.clean)),
    // Code generation
    modules: modules.length,
    firstPassValidatorRate: rate(modules.map((m) => m.firstPassPassed)),
    finalValidatorRate: rate(modules.map((m) => m.passed)),
    avgValidatorScore: mean(modules.map((m) => m.score)),
    avgIterations: mean(modules.map((m) => m.iterations)),
    invalidOutputRate: rate(modules.map((m) => m.invalid)),
    fallbackRate: rate(modules.map((m) => m.fallback)),
    requirementCoverage: mean(ok.map((r) => r.coverage)),
    // Sandbox execution
    sandboxRuns: sandboxRan.length,
    sandboxSkipped: ok.length - sandboxRan.length,
    taskCompletionRate: sandboxRan.length ? rate(sandboxRan.map((r) => r.sandbox.success)) : null,
    testPassRate: totalTests ? passedTests / totalTests : null,
    // Cost
    avgLatencyMs: mean(ok.map((r) => r.latencyMs)),
    avgInputTokens: tokensKnown.length ? mean(tokensKnown.map((r) => r.tokens.input)) : null,
    avgOutputTokens: tokensKnown.length ? mean(tokensKnown.map((r) => r.tokens.output)) : null,
  };
}

module.exports = { MODULE_NAMES, scoreDecomposition, requirementCoverage, aggregate };
