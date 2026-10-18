'use strict';

/**
 * Minimal tracing for agent workflows.
 *
 *   trace('pipeline', { id: taskId }, fn)        root span (one per pipeline run)
 *   span('decompose', { input }, async (h) => …) child span; h.setOutput / h.setUsage / h.setMetadata
 *   span('llm', { type: 'generation', model }, …) LLM call (usage = { input, output } tokens)
 *
 * Context propagates through async calls via AsyncLocalStorage. It does NOT
 * cross the BullMQ boundary, so callers pass `currentContext()` in job data and
 * the processor re-enters it with `runInContext()`.
 *
 * Spans outside a trace are no-ops. Sinks receive every finished span:
 *   - jsonl:    appends to logs/traces.jsonl (always on unless TRACE_FILE=off)
 *   - langfuse: enabled when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set
 * A sink failure never breaks the pipeline.
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redact } = require('../utils/redact');

const als = new AsyncLocalStorage();
let sinks = [];

const MAX_FIELD_CHARS = 2000;

// ─── Helpers ───────────────────────────────────────────────────────────────

const newId = () => crypto.randomBytes(8).toString('hex');

/** JSON-safe, size-capped copy of a value for storing in a span. */
function clip(value) {
  if (value === undefined) return undefined;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = redact(text);
  if (text.length <= MAX_FIELD_CHARS) return typeof value === 'string' ? text : safeParse(text);
  return text.slice(0, MAX_FIELD_CHARS) + `… [truncated ${text.length - MAX_FIELD_CHARS} chars]`;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// ─── Context ───────────────────────────────────────────────────────────────

function currentContext() {
  return als.getStore() || null;
}

/** Re-enter a context captured with currentContext() (e.g. inside a queue worker). */
function runInContext(ctx, fn) {
  return ctx ? als.run({ traceId: ctx.traceId, spanId: ctx.spanId }, fn) : fn();
}

// ─── Span lifecycle ────────────────────────────────────────────────────────

async function run({ name, type, traceId, parentId, input, metadata, model }, fn) {
  const record = {
    traceId,
    spanId: newId(),
    parentId: parentId || null,
    name,
    type,
    startTime: new Date().toISOString(),
    input: clip(input),
    metadata: metadata || {},
    model,
  };
  const t0 = process.hrtime.bigint();

  const handle = {
    setOutput: (o) => { record.output = clip(o); },
    setUsage: (u) => { if (u) record.usage = { input: u.input || 0, output: u.output || 0 }; },
    setMetadata: (m) => { Object.assign(record.metadata, m); },
  };

  const finish = (status, error) => {
    record.endTime = new Date().toISOString();
    record.durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    record.status = status;
    if (error) record.error = redact(String(error.message || error)).slice(0, 500);
    for (const sink of sinks) {
      try { sink.onSpanEnd(record); } catch { /* sinks must never break the pipeline */ }
    }
  };

  try {
    const result = await als.run({ traceId, spanId: record.spanId }, () => fn(handle));
    finish('ok');
    return result;
  } catch (err) {
    finish('error', err);
    throw err;
  }
}

/** Start a root trace. `id` lets the trace share the pipeline's taskId. */
function trace(name, { id, input, metadata } = {}, fn) {
  return run({ name, type: 'trace', traceId: id || newId(), input, metadata }, fn);
}

/** Child span of the current context; plain call-through when there is none. */
function span(name, { type = 'span', input, metadata, model } = {}, fn) {
  const ctx = als.getStore();
  if (!ctx) {
    return fn({ setOutput() {}, setUsage() {}, setMetadata() {} });
  }
  return run({ name, type, traceId: ctx.traceId, parentId: ctx.spanId, input, metadata, model }, fn);
}

// ─── Sinks ─────────────────────────────────────────────────────────────────

function jsonlSink(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { name: 'jsonl', onSpanEnd: (rec) => fs.appendFile(file, JSON.stringify(rec) + '\n', () => {}) };
}

function memorySink() {
  const spans = [];
  return { name: 'memory', spans, onSpanEnd: (rec) => spans.push(rec) };
}

/** Langfuse export. `client` is injectable for tests. */
function langfuseSink(client) {
  const toBody = (rec) => ({
    id: rec.spanId,
    traceId: rec.traceId,
    parentObservationId: rec.parentId || undefined,
    name: rec.name,
    startTime: new Date(rec.startTime),
    endTime: new Date(rec.endTime),
    input: rec.input,
    output: rec.output,
    metadata: rec.metadata,
    level: rec.status === 'error' ? 'ERROR' : 'DEFAULT',
    statusMessage: rec.error,
  });
  return {
    name: 'langfuse',
    onSpanEnd(rec) {
      if (rec.type === 'trace') {
        client.trace({ id: rec.traceId, name: rec.name, input: rec.input, output: rec.output, metadata: rec.metadata });
      } else if (rec.type === 'generation') {
        client.generation({ ...toBody(rec), model: rec.model, usage: rec.usage });
      } else {
        client.span(toBody(rec));
      }
    },
    flush: () => client.flushAsync(),
    shutdown: () => client.shutdownAsync(),
  };
}

function addSink(sink) { sinks.push(sink); return sink; }
function resetSinks() { sinks = []; }

/** Wire up sinks from environment. Safe to call once at startup. */
function initFromEnv(env = process.env) {
  resetSinks();
  if (env.TRACE_FILE !== 'off') {
    try {
      addSink(jsonlSink(env.TRACE_FILE || path.join('logs', 'traces.jsonl')));
    } catch (err) {
      console.error(`Trace file disabled: ${redact(err.message)}`); // unwritable path must not stop the app
    }
  }
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    try {
      const { Langfuse } = require('langfuse'); // inside the try: a failed import must not stop the app
      addSink(langfuseSink(new Langfuse({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com',
        // an unreachable Langfuse must never stall the app: short timeouts, few retries
        requestTimeout: 5000,
        fetchRetryCount: 1,
        fetchRetryDelay: 500,
      })));
    } catch (err) {
      // tracing is optional: run without it rather than refusing to start
      console.error(`Langfuse disabled (init failed): ${redact(err.message)}`);
    }
  }
  return sinks.map((s) => s.name);
}

/** Flush sinks, but never hold up process exit for more than `timeoutMs` (offline backends). */
async function shutdown({ timeoutMs = 5000 } = {}) {
  const flush = Promise.all(sinks.map((s) => (s.shutdown ? Promise.resolve().then(() => s.shutdown()).catch(() => {}) : null)));
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([flush, timeout]);
  clearTimeout(timer);
}

module.exports = {
  trace, span, currentContext, runInContext,
  addSink, resetSinks, initFromEnv, shutdown,
  jsonlSink, memorySink, langfuseSink, clip,
};
