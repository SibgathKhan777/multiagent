'use strict';

/**
 * Structural check for eval result files (hand-rolled to avoid a dependency).
 * Run in CI so a malformed or hand-edited result can't be committed as "evidence".
 */

const SUITES = ['pipeline', 'codegen', 'tools'];
const MODES = ['mock', 'live'];

function validateResult(r) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(r && typeof r === 'object', 'result must be an object');
  if (!r || typeof r !== 'object') return errors;

  need(r.schemaVersion === 1, 'schemaVersion must be 1');
  need(SUITES.includes(r.suite), `suite must be one of ${SUITES.join(', ')}`);
  need(MODES.includes(r.mode), `mode must be one of ${MODES.join(', ')}`);
  need(typeof r.label === 'string' && r.label.length > 0, 'label required');
  need(!Number.isNaN(Date.parse(r.createdAt)), 'createdAt must be an ISO date');
  need(r.config && typeof r.config === 'object', 'config required');
  need(r.config && typeof r.config.datasetHash === 'string', 'config.datasetHash required');
  need(r.config && typeof r.config.provider === 'string', 'config.provider required');
  need(r.summary && typeof r.summary === 'object', 'summary required');
  need(Array.isArray(r.results), 'results must be an array');

  if (r.summary && r.summary.denominators) {
    const d = r.summary.denominators;
    for (const [k, v] of Object.entries(d)) need(Number.isInteger(v) && v >= 0, `denominators.${k} must be a non-negative integer`);
  } else if (r.suite !== 'pipeline') {
    errors.push('summary.denominators required (every reported rate needs its denominator)');
  }

  if (r.summary) {
    for (const [k, v] of Object.entries(r.summary)) {
      if (typeof v === 'number') need(Number.isFinite(v), `summary.${k} must be finite`);
      if (/Rate$|Validity$|Accuracy$/.test(k) && typeof v === 'number') need(v >= 0 && v <= 1, `summary.${k} must be within [0,1]`);
    }
  }

  if (r.suite === 'codegen' && Array.isArray(r.results) && r.summary?.denominators) {
    need(r.summary.denominators.tasks === r.results.length, 'denominators.tasks must equal results.length');
    for (const t of r.results) need(t.id && Array.isArray(t.attempts) && t.attempts.length > 0, `codegen result ${t.id}: attempts required`);
  }
  if (r.mode === 'mock') need(r.config && r.config.provider === 'mock', 'mock results must declare provider "mock" (never mix with live numbers)');

  return errors;
}

module.exports = { validateResult, SUITES, MODES };
