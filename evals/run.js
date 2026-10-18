#!/usr/bin/env node
'use strict';

/**
 * Usage: node evals/run.js --label baseline [--limit N] [--no-sandbox] [--task t01]
 * Writes evals/results/<label>.json. Needs no DB/Redis. Uses AI_PROVIDER from .env.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runTask } = require('./harness');
const { aggregate } = require('./metrics');
const modelsConfig = require('../config/models');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

async function main() {
  const label = arg('label', 'local-run');
  const datasetPath = path.join(__dirname, 'dataset.json');
  const raw = fs.readFileSync(datasetPath, 'utf8');
  let tasks = JSON.parse(raw).tasks;
  if (arg('task')) tasks = tasks.filter((t) => t.id === arg('task'));
  if (arg('limit')) tasks = tasks.slice(0, parseInt(arg('limit'), 10));
  const sandbox = !process.argv.includes('--no-sandbox');

  if (sandbox) {
    const probe = require('child_process').spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status !== 0) {
      console.error('Docker is not reachable but the sandbox is enabled — start Docker or pass --no-sandbox.');
      process.exit(2);
    }
  }

  const provider = modelsConfig.provider;
  console.log(`Eval "${label}": ${tasks.length} tasks, provider=${provider}, sandbox=${sandbox}`);
  if (provider === 'simulated') {
    console.warn('⚠️  provider=simulated: results measure the template generator, NOT an LLM.');
  }

  const results = [];
  for (const task of tasks) {
    try {
      const r = await runTask(task, { sandbox });
      const done = r.sandbox ? (r.sandbox.skipped ? 'sandbox-skipped' : r.sandbox.success ? 'PASS' : 'FAIL') : 'n/a';
      console.log(`  ${task.id} recall=${r.decomposition.recall.toFixed(2)} cov=${r.coverage.toFixed(2)} exec=${done} ${r.latencyMs}ms`);
      results.push(r);
      if (provider !== 'simulated' && r.modules.some((m) => m.fallback) && !process.argv.includes('--allow-fallback')) {
        console.error(`\n❌ ${task.id}: the LLM call failed and a template was substituted (rate limit / bad model name?). Aborting so the results aren't contaminated. Pass --allow-fallback to keep going.`);
        process.exit(3);
      }
    } catch (err) {
      console.log(`  ${task.id} ERROR ${err.message}`);
      results.push({ id: task.id, idea: task.idea, error: err.message });
    }
  }

  const report = {
    schemaVersion: 1,
    suite: 'pipeline',
    mode: 'live',
    config: { provider, models: modelsConfig[provider]?.models || null, sandbox, datasetHash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12) },
    label,
    createdAt: new Date().toISOString(),
    provider,
    models: modelsConfig[provider]?.models || null,
    datasetHash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
    sandbox,
    summary: aggregate(results),
    results,
  };
  const out = path.join(__dirname, 'results', `${label}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nSummary:', JSON.stringify(report.summary, null, 2));
  console.log(`Saved ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
