'use strict';

/**
 * LLM provider error handling: classification and bounded retry.
 *
 * kinds:  rate_limit | quota (daily limit; waiting is pointless) | timeout | transient
 *         | malformed_generation (model emitted a tool-call-shaped/unusable reply; Groq reports this
 *           as a 400 `tool_use_failed` but it is non-deterministic and a retry usually works)
 *         | auth | config (bad model/endpoint) | bad_request | empty_response | unknown
 * Only rate_limit (short waits), timeout and transient are retried.
 */

const { redact } = require('../utils/redact');

function statusOf(err) {
  if (typeof err?.status === 'number') return err.status;
  const m = String(err?.message || '').match(/\[(\d{3})\b|^(\d{3})\s/);
  return m ? parseInt(m[1] || m[2], 10) : null;
}

/** Parse "try again in 11m10.46s" / "in 6.5s" style hints into ms. */
function parseRetryAfterMs(err) {
  const header = err?.headers?.['retry-after'] ?? err?.headers?.get?.('retry-after');
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  const m = String(err?.message || '').match(/try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/i);
  if (!m) return null;
  const [, h, min, s, ms] = m;
  const total = (+h || 0) * 3600000 + (+min || 0) * 60000 + (+s || 0) * 1000 + (+ms || 0);
  return total || null;
}

function classifyError(err, { maxRetryWaitMs = 15000 } = {}) {
  const status = statusOf(err);
  const msg = String(err?.message || '');
  const retryAfterMs = parseRetryAfterMs(err);
  let kind = 'unknown';

  if (err?.name === 'LlmTimeoutError' || err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) kind = 'timeout';
  else if (err?.name === 'EmptyResponseError') kind = 'empty_response';
  else if (status === 429) {
    const daily = /per day|\(TPD\)|\(RPD\)|quota/i.test(msg);
    kind = daily || (retryAfterMs && retryAfterMs > maxRetryWaitMs) ? 'quota' : 'rate_limit';
  } else if (/tool_use_failed|model called a tool/i.test(msg) || err?.code === 'tool_use_failed') kind = 'malformed_generation';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 404 || /model_not_found|no longer available|does not exist/i.test(msg)) kind = 'config';
  else if (status === 400 || status === 422) kind = 'bad_request';
  else if ((status && status >= 500) || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i.test(msg) || /ECONNRESET|ETIMEDOUT/.test(err?.code || '')) kind = 'transient';

  const retryable = ['rate_limit', 'timeout', 'transient', 'malformed_generation', 'empty_response'].includes(kind);
  return { kind, retryable, status, retryAfterMs, message: redact(msg).slice(0, 400) };
}

class LlmTimeoutError extends Error {
  constructor(ms) { super(`LLM request timed out after ${ms}ms`); this.name = 'LlmTimeoutError'; }
}
class EmptyResponseError extends Error {
  constructor() { super('LLM returned an empty response'); this.name = 'EmptyResponseError'; }
}

function withTimeout(promiseFactory, ms) {
  let timer;
  return Promise.race([
    promiseFactory(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new LlmTimeoutError(ms)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run `fn` with a timeout per attempt and bounded retries.
 * @returns {Promise<{ value, attempts }>}  rejects with an Error carrying `.llm = { kind, retryable, attempts, ... }`
 */
async function callWithRetry(fn, {
  maxAttempts = 3, baseDelayMs = 1000, maxRetryWaitMs = 15000, timeoutMs = 60000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry = () => {},
} = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const value = await withTimeout(fn, timeoutMs);
      return { value, attempts: attempt };
    } catch (err) {
      const info = classifyError(err, { maxRetryWaitMs });
      if (!info.retryable || attempt >= maxAttempts) {
        const wrapped = new Error(redact(err.message));
        wrapped.llm = { ...info, attempts: attempt };
        throw wrapped;
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
      const wait = Math.min(Math.max(backoff, info.retryAfterMs || 0), maxRetryWaitMs);
      onRetry({ attempt, kind: info.kind, waitMs: wait });
      await sleep(wait);
    }
  }
}

module.exports = { classifyError, callWithRetry, withTimeout, parseRetryAfterMs, LlmTimeoutError, EmptyResponseError };
