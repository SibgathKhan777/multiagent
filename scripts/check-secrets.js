#!/usr/bin/env node
'use strict';

/**
 * Dependency-free secret scan over git-tracked (and untracked, non-ignored) files (runs locally and in CI).
 * Fails on credential-shaped strings, private keys, and tracked .env files.
 * Test fixtures with deliberately fake keys live under tests/ and are skipped.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP = [/^package-lock\.json$/, /^tests\//, /^evals\/results\//, /^\.github\/workflows\//];
const RULES = [
  ['Groq API key', /\bgsk_[A-Za-z0-9]{30,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_\-]{35}\b/],
  ['OpenAI/Anthropic-style key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{32,}\b/],
  ['Langfuse key', /\b(?:pk|sk)-lf-[0-9a-f\-]{30,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Mongo URI with password', /mongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]{3,}@/],
];

// tracked + untracked-but-not-ignored, so new files are checked before they are ever committed
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];

for (const file of tracked) {
  if (/(^|\/)\.env$/.test(file) || /(^|\/)\.env\.(local|production)$/.test(file)) findings.push(`${file}: a real .env file is tracked by git`);
  if (SKIP.some((re) => re.test(file))) continue;
  let text;
  try { text = fs.readFileSync(path.join(process.cwd(), file), 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue; // binary
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of RULES) if (re.test(line)) findings.push(`${file}:${i + 1}: ${name}`);
  });
}

const ignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
if (!/^\.env$/m.test(ignore)) findings.push('.gitignore: ".env" is not ignored');

if (findings.length) {
  console.error(`✗ possible secrets:\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ no secrets found in ${tracked.length} files`);
