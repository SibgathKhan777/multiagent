#!/usr/bin/env node
'use strict';

/**
 * Tool-selection eval over the real MCP server/client.
 *   Mock: node evals/run-tools.js --mode mock --behavior oracle|naive|never|sloppy
 *   Live: node evals/run-tools.js --mode live --label tools-baseline     (provider must be groq)
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const modelsConfig = require('../config/models');
const { McpToolClient } = require('../src/mcp/client');
const { runToolsSuite } = require('./tools/suite');
const { mocks, groqSelector } = require('./tools/selectors');
const { validateResult } = require('./schema');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

async function main() {
  const mode = arg('mode', 'mock');
  const raw = fs.readFileSync(path.join(__dirname, 'tools', 'scenarios.json'), 'utf8');
  let scenarios = JSON.parse(raw).scenarios;
  if (arg('limit')) scenarios = scenarios.slice(0, parseInt(arg('limit'), 10));
  const label = arg('label', `local-tools-${mode}`);

  let select; let provider; let models = null;
  if (mode === 'mock') {
    const behaviour = arg('behavior', 'oracle');
    if (!mocks[behaviour]) throw new Error(`Unknown behaviour "${behaviour}" (have: ${Object.keys(mocks).join(', ')})`);
    select = mocks[behaviour]; provider = 'mock'; models = { behaviour };
  } else if (mode === 'live') {
    provider = modelsConfig.provider;
    if (provider !== 'groq') throw new Error(`live tool-selection eval supports provider=groq only (got ${provider})`);
    const model = modelsConfig.groq.models.fast;
    select = groqSelector({ apiKey: modelsConfig.groq.apiKey, model });
    models = { selector: model };
  } else throw new Error('--mode must be mock or live');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-factory-toolseval-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Demo project\nA tiny workspace for tool-selection evals.\n');
  fs.writeFileSync(path.join(workspace, 'src/app.js'), "module.exports = { start() { return 'ok'; } };\n");
  fs.writeFileSync(path.join(workspace, 'src/utils.js'), 'module.exports = { noop() {} };\n');

  const client = await new McpToolClient({ workspace }).connect();
  console.log(`Tools eval "${label}": ${scenarios.length} scenarios, mode=${mode}, provider=${provider}, discovered tools: ${client.listTools().map((t) => t.name).join(', ')}`);

  try {
    const out = await runToolsSuite({
      scenarios, select, client,
      onScenario: (r) => {
        console.log(`  ${r.id.padEnd(22)} ${r.selection.correct ? 'OK  ' : 'MISS'} ${r.selection.kind}${r.chosen ? ` → ${r.chosen}` : ''}${r.execution && !r.execution.ok ? ` [${r.execution.rejected ? 'rejected' : 'error'}]` : ''}`);
        return mode === 'live' && r.providerError && /quota|auth|config/.test(r.providerError);
      },
    });

    const report = {
      schemaVersion: 1, suite: 'tools', mode, label, createdAt: new Date().toISOString(),
      config: { provider, models, datasetHash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12), exposedTools: client.listTools().map((t) => t.name) },
      summary: out.summary, results: out.results, failedCases: out.failedCases,
    };
    const errors = validateResult(report);
    if (errors.length) throw new Error(`Refusing to write an invalid report: ${errors.join('; ')}`);
    const file = path.join(__dirname, 'results', `${label}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log('\nSummary:', JSON.stringify(out.summary, null, 2));
    console.log(`Saved ${file}`);
  } finally {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
