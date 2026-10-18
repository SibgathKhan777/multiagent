#!/usr/bin/env node
'use strict';

/** Usage: node evals/validate-results.js [files...]  (default: every evals/results/*.json except local-*) */
const fs = require('fs');
const path = require('path');
const { validateResult } = require('./schema');

const dir = path.join(__dirname, 'results');
let files = process.argv.slice(2);
if (!files.length) files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('local-')).map((f) => path.join(dir, f));

let bad = 0;
for (const f of files) {
  let errs;
  try { errs = validateResult(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { errs = [`unreadable: ${e.message}`]; }
  if (errs.length) { bad++; console.error(`✗ ${f}\n  - ${errs.join('\n  - ')}`); } else console.log(`✓ ${path.basename(f)}`);
}
console.log(`${files.length - bad}/${files.length} result file(s) valid`);
process.exit(bad ? 1 : 0);
