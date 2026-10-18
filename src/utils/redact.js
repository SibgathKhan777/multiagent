'use strict';

/**
 * Secret redaction for anything that gets logged, traced or returned to clients.
 * Covers common API key shapes plus the exact values of known secret env vars.
 */

const PATTERNS = [
  /\bgsk_[A-Za-z0-9]{20,}\b/g,                 // Groq
  /\bAIza[0-9A-Za-z_\-]{30,}\b/g,              // Google
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g,               // OpenAI/Anthropic style
  /\b(?:pk|sk)-lf-[0-9a-f\-]{20,}\b/g,         // Langfuse
  /\bBearer\s+[A-Za-z0-9._\-]{16,}/gi,
  /\b((?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

const SECRET_ENV = /(?:KEY|SECRET|TOKEN|PASSWORD)$/i;

function knownSecrets(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v);
}

function redact(value, env = process.env) {
  if (value === null || value === undefined) return value;
  let text = typeof value === 'string' ? value : String(value);
  for (const secret of knownSecrets(env)) {
    text = text.split(secret).join('[REDACTED]');
  }
  for (const re of PATTERNS) {
    text = text.replace(re, (m, prefix) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return text;
}

module.exports = { redact };
