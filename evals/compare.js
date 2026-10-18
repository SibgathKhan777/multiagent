#!/usr/bin/env node
'use strict';

/**
 * Regression gate.
 * Usage: node evals/compare.js results/baseline.json results/candidate.json [--tolerance 0.02]
 * Exit 1 if any quality metric regressed by more than the tolerance.
 */

const fs = require('fs');

// metric → direction. 'up' = higher is better, 'down' = lower is better. gate=false → report only.
const METRICS = {
  decompositionRecall:    { dir: 'up', gate: true },
  decompositionCleanRate: { dir: 'up', gate: true },
  firstPassValidatorRate: { dir: 'up', gate: true },
  finalValidatorRate:     { dir: 'up', gate: true },
  requirementCoverage:    { dir: 'up', gate: true },
  taskCompletionRate:     { dir: 'up', gate: true },
  testPassRate:           { dir: 'up', gate: true },
  invalidOutputRate:      { dir: 'down', gate: true },
  fallbackRate:           { dir: 'down', gate: true },
  avgIterations:          { dir: 'down', gate: false },
  avgLatencyMs:           { dir: 'down', gate: false },
  avgInputTokens:         { dir: 'down', gate: false },
  avgOutputTokens:        { dir: 'down', gate: false },
};

function compare(base, cand, tolerance = 0.02) {
  const problems = [];
  if (base.datasetHash !== cand.datasetHash) problems.push(`dataset differs (${base.datasetHash} vs ${cand.datasetHash}) — results are not comparable`);
  if (base.provider !== cand.provider) problems.push(`provider differs (${base.provider} vs ${cand.provider}) — results are not comparable`);

  const rows = [];
  const regressions = [];
  for (const [metric, { dir, gate }] of Object.entries(METRICS)) {
    const a = base.summary[metric];
    const b = cand.summary[metric];
    if (a == null || b == null) { rows.push({ metric, a, b, delta: null, status: 'n/a' }); continue; }
    const delta = b - a;
    const worse = dir === 'up' ? delta < -tolerance * Math.max(1, Math.abs(a)) : delta > tolerance * Math.max(1, Math.abs(a));
    const better = dir === 'up' ? delta > 0 : delta < 0;
    const status = delta === 0 ? 'same' : worse ? (gate ? 'REGRESSION' : 'worse') : better ? 'better' : 'same';
    if (status === 'REGRESSION') regressions.push(metric);
    rows.push({ metric, a, b, delta, status });
  }
  return { problems, rows, regressions, ok: problems.length === 0 && regressions.length === 0 };
}

function format(report) {
  const f = (x) => (x == null ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3));
  const lines = ['metric'.padEnd(26) + 'baseline'.padStart(10) + 'candidate'.padStart(11) + 'delta'.padStart(10) + '  status'];
  for (const r of report.rows) {
    lines.push(r.metric.padEnd(26) + f(r.a).padStart(10) + f(r.b).padStart(11) + (r.delta == null ? '—' : (r.delta > 0 ? '+' : '') + f(r.delta)).padStart(10) + '  ' + r.status);
  }
  for (const p of report.problems) lines.push(`⚠️  ${p}`);
  lines.push(report.ok ? '\n✅ No regressions' : `\n❌ ${report.regressions.length} regression(s)${report.problems.length ? ', incomparable runs' : ''}`);
  return lines.join('\n');
}

if (require.main === module) {
  const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  if (!a || !b) { console.error('Usage: compare.js <baseline.json> <candidate.json> [--tolerance 0.02]'); process.exit(2); }
  const ti = process.argv.indexOf('--tolerance');
  const report = compare(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8')), ti > -1 ? parseFloat(process.argv[ti + 1]) : 0.02);
  console.log(format(report));
  process.exit(report.ok ? 0 : 1);
}

module.exports = { compare, format, METRICS };
