'use strict';

/**
 * Pipeline outcome — separates "the workflow finished" from "the artifact is
 * verified". A run can finish while its generated application is broken.
 *
 *   verified    every module passed validation, real LLM output, tests ran and passed
 *   unverified  nothing failed, but something couldn't be confirmed (sandbox
 *               unavailable, or template output from the simulated provider)
 *   failed      a module never passed validation, the LLM was replaced by a
 *               template after an API failure, or the generated tests failed
 */

/**
 * @param {Object}   p
 * @param {Array}    p.modules    [{ name, validationPassed, usedFallback, score }]
 * @param {Object}   [p.execution] executor result
 * @param {string}   p.provider   'groq' | 'gemini' | 'python-ai' | 'simulated'
 * @returns {{ verdict: 'verified'|'unverified'|'failed', reasons: string[] }}
 */
function computeOutcome({ modules, execution, provider }) {
  const reasons = [];
  let verdict = 'verified';
  const downgrade = (to) => {
    const rank = { verified: 0, unverified: 1, failed: 2 };
    if (rank[to] > rank[verdict]) verdict = to;
  };

  const invalid = modules.filter((m) => !m.validationPassed);
  if (invalid.length) {
    downgrade('failed');
    reasons.push(`${invalid.length} module(s) did not pass validation after the retry limit: ${invalid.map((m) => `${m.name} (score ${m.score})`).join(', ')}`);
  }

  const realProvider = provider !== 'simulated';
  const fellBack = realProvider ? modules.filter((m) => m.usedFallback) : [];
  if (fellBack.length) {
    downgrade('failed');
    reasons.push(`LLM call failed and template code was substituted for: ${fellBack.map((m) => m.name).join(', ')}`);
  }

  if (!execution) {
    downgrade('unverified');
    reasons.push('Generated project was not executed');
  } else if (execution.skipped) {
    downgrade('unverified');
    reasons.push('Sandbox unavailable (Docker): tests were not run');
  } else if (!execution.success) {
    downgrade('failed');
    const t = execution.tests || {};
    reasons.push(`Generated project failed in the sandbox (${t.passed ?? 0}/${t.total ?? 0} tests passed): ${(execution.errors || []).slice(0, 2).join('; ') || 'no details'}`);
  }

  if (!realProvider) {
    downgrade('unverified');
    reasons.push('Code came from the simulated template generator, not an LLM');
  }

  return { verdict, reasons };
}

module.exports = { computeOutcome };
