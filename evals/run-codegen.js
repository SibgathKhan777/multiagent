#!/usr/bin/env node
'use strict';

/**
 * Codegen eval.
 *   Mock (deterministic, free, CI):  node evals/run-codegen.js --mode mock --behavior mixed
 *   Live  (real provider, Docker):   node evals/run-codegen.js --mode live --label baseline --limit 5
 *
 * Mock results measure the eval + pipeline machinery, NOT any model. They are tagged
 * provider "mock" and can never be compared with live results.
 * Live mode always grades inside Docker; model output is never run on the host.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const modelsConfig = require('../config/models');
const { runCodegenSuite } = require('./codegen/suite');
const { makeMockProvider } = require('./codegen/mockModels');
const { validateResult } = require('./schema');
const { dockerAvailable, runProcess } = require('../src/agents/executor');
const tracer = require('../src/observability/tracer');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

async function main() {
  const mode = arg('mode', 'mock');
  if (!['mock', 'live'].includes(mode)) throw new Error('--mode must be mock or live');
  const raw = fs.readFileSync(path.join(__dirname, 'codegen', 'tasks.json'), 'utf8');
  let tasks = JSON.parse(raw).tasks;
  if (arg('task')) tasks = tasks.filter((t) => t.id === arg('task'));
  if (arg('limit')) tasks = tasks.slice(0, parseInt(arg('limit'), 10));
  const label = arg('label', `local-codegen-${mode}`);
  const maxAttempts = parseInt(arg('max-attempts', '2'), 10);

  let providers; let provider; let gradeMode; let models = null;
  if (mode === 'mock') {
    const behaviour = arg('behavior', 'mixed');
    process.env.LLM_BASE_DELAY_MS = process.env.LLM_BASE_DELAY_MS || '1';
    modelsConfig.provider = provider = 'mock';
    providers = { mock: makeMockProvider(behaviour, tasks.map((t) => t.id)) };
    gradeMode = arg('sandbox', 'local-trusted'); // fixtures are ours; safe to run on the host
    models = { behaviour };
  } else {
    provider = modelsConfig.provider;
    if (provider === 'simulated') throw new Error('live mode with AI_PROVIDER=simulated would measure templates, not a model');
    gradeMode = 'docker'; // never anything else for model output
    if (!(await dockerAvailable(runProcess))) throw new Error('Docker is not reachable — live evals grade untrusted model output in a sandbox. Start Docker.');
    models = modelsConfig[provider]?.models || null;
  }

  console.log(`Codegen eval "${label}": ${tasks.length} tasks, mode=${mode}, provider=${provider}, grading=${gradeMode}, maxAttempts=${maxAttempts}`);
  const FATAL = new Set(['quota', 'auth', 'config']);
  let aborted = null;

  tracer.initFromEnv();
  const out = await tracer.trace('eval:codegen', { id: `${label}-${Date.now()}`, input: { mode, provider, tasks: tasks.length } }, async (h) => {
    const r = await runCodegenSuite({
    tasks, providers, gradeMode, maxAttempts,
    onTask: (r) => {
      const last = r.attempts[r.attempts.length - 1];
      console.log(`  ${r.id.padEnd(14)} ${r.success ? 'PASS' : 'FAIL'} ${r.finalClass}${r.recoveredByRetry ? ' (recovered by retry)' : ''} ${last.passedTests}/${last.totalTests} tests`);
      if (mode === 'live' && r.finalClass === 'provider_error' && FATAL.has(last.providerErrorKind)) {
        aborted = `${r.id}: ${last.providerErrorKind}`;
        return true; // stop: a quota/auth/config error will not fix itself, don't burn through the dataset
      }
      return false;
    },
    });
    h.setOutput(r.summary);
    return r;
  });

  const report = {
    schemaVersion: 1,
    suite: 'codegen',
    mode,
    label,
    createdAt: new Date().toISOString(),
    config: {
      provider, models, maxAttempts, grading: gradeMode,
      datasetHash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
      taskIds: tasks.map((t) => t.id), // requested; see denominators.tasks for how many actually ran
      aborted,
      note: mode === 'mock' ? 'Scripted model: measures eval/pipeline machinery only.' : 'Live model output graded in Docker. Attempt 2 sees the failing hidden cases (mirrors the pipeline repair loop).',
    },
    summary: out.summary,
    results: out.results,
    failedCases: out.failedCases,
  };
  await tracer.shutdown();
  const errors = validateResult(report);
  if (errors.length) throw new Error(`Refusing to write an invalid report: ${errors.join('; ')}`);

  const file = path.join(__dirname, 'results', `${label}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('\nSummary:', JSON.stringify(out.summary, null, 2));
  console.log(`Saved ${file}`);
  if (aborted) console.warn(`\n⚠️  Stopped early on a non-recoverable provider error (${aborted}); only ${out.results.length}/${tasks.length} tasks ran.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
