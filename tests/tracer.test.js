const tracer = require('../src/observability/tracer');

describe('tracer', () => {
  let mem;
  beforeEach(() => { tracer.resetSinks(); mem = tracer.addSink(tracer.memorySink()); });
  afterAll(() => tracer.resetSinks());

  test('builds a parent/child tree with timing, input and output', async () => {
    await tracer.trace('pipeline', { id: 'task-1', input: { idea: 'x' } }, async () => {
      await tracer.span('decompose', { input: 'x' }, async (h) => { h.setOutput(['A', 'B']); });
      await tracer.span('module', {}, async () => {
        await tracer.span('validate', {}, async (h) => { h.setOutput({ score: 80 }); });
      });
    });
    const by = Object.fromEntries(mem.spans.map((s) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(['decompose', 'module', 'pipeline', 'validate']);
    expect(by.pipeline.traceId).toBe('task-1');
    expect(by.pipeline.parentId).toBeNull();
    expect(by.decompose.parentId).toBe(by.pipeline.spanId);
    expect(by.validate.parentId).toBe(by.module.spanId);
    expect(new Set(mem.spans.map((s) => s.traceId))).toEqual(new Set(['task-1']));
    expect(by.decompose.output).toEqual(['A', 'B']);
    expect(typeof by.validate.durationMs).toBe('number');
    expect(by.pipeline.status).toBe('ok');
  });

  test('records errors and rethrows', async () => {
    await expect(tracer.trace('t', {}, async () => {
      await tracer.span('boom', {}, async () => { throw new Error('bad'); });
    })).rejects.toThrow('bad');
    const boom = mem.spans.find((s) => s.name === 'boom');
    expect(boom).toMatchObject({ status: 'error', error: 'bad' });
    expect(mem.spans.find((s) => s.name === 't').status).toBe('error');
  });

  test('span outside a trace is a no-op that still runs the function', async () => {
    const r = await tracer.span('orphan', {}, async (h) => { h.setOutput(1); return 42; });
    expect(r).toBe(42);
    expect(mem.spans).toHaveLength(0);
  });

  test('context crosses a boundary via currentContext/runInContext', async () => {
    let captured;
    await tracer.trace('root', { id: 'T' }, async () => { captured = tracer.currentContext(); });
    // simulate a queue worker: no ambient context, context restored from job data
    await tracer.runInContext(JSON.parse(JSON.stringify(captured)), () => tracer.span('queued', {}, async () => {}));
    const root = mem.spans.find((s) => s.name === 'root');
    const queued = mem.spans.find((s) => s.name === 'queued');
    expect(queued.traceId).toBe('T');
    expect(queued.parentId).toBe(root.spanId);
  });

  test('generation spans carry model and token usage', async () => {
    await tracer.trace('t', {}, () => tracer.span('llm', { type: 'generation', model: 'm1' }, async (h) => { h.setUsage({ input: 10, output: 20 }); }));
    expect(mem.spans.find((s) => s.name === 'llm')).toMatchObject({ type: 'generation', model: 'm1', usage: { input: 10, output: 20 } });
  });

  test('truncates large inputs/outputs', async () => {
    await tracer.trace('t', {}, () => tracer.span('big', { input: 'x'.repeat(10000) }, async () => {}));
    expect(mem.spans.find((s) => s.name === 'big').input.length).toBeLessThan(2100);
  });

  test('a throwing sink never breaks the pipeline', async () => {
    tracer.addSink({ onSpanEnd() { throw new Error('sink down'); } });
    await expect(tracer.trace('t', {}, async () => 'ok')).resolves.toBe('ok');
  });

  test('langfuse sink maps trace/span/generation calls', async () => {
    tracer.resetSinks();
    const calls = [];
    const client = { trace: (b) => calls.push(['trace', b]), span: (b) => calls.push(['span', b]), generation: (b) => calls.push(['generation', b]) };
    tracer.addSink(tracer.langfuseSink(client));
    await tracer.trace('root', { id: 'T' }, async () => {
      await tracer.span('s', {}, async () => {});
      await tracer.span('g', { type: 'generation', model: 'm' }, async (h) => h.setUsage({ input: 1, output: 2 }));
    });
    expect(calls.map((c) => c[0]).sort()).toEqual(['generation', 'span', 'trace']);
    const gen = calls.find((c) => c[0] === 'generation')[1];
    expect(gen).toMatchObject({ traceId: 'T', model: 'm', usage: { input: 1, output: 2 } });
    expect(gen.parentObservationId).toBeDefined();
    expect(calls.find((c) => c[0] === 'trace')[1]).toMatchObject({ id: 'T', name: 'root' });
  });
});

describe('tracer: degradation and redaction', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let mem;
  beforeEach(() => { tracer.resetSinks(); mem = tracer.addSink(tracer.memorySink()); });
  afterAll(() => tracer.resetSinks());

  test('secrets in span inputs/outputs/errors are redacted', async () => {
    const key = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
    await expect(tracer.trace('t', { input: { header: `Bearer ${'a'.repeat(30)}` } }, () =>
      tracer.span('call', { input: `key=${key}` }, async (h) => { h.setOutput({ echoed: key }); throw new Error(`401 for ${key}`); }))).rejects.toThrow();
    const dump = JSON.stringify(mem.spans);
    expect(dump).not.toContain(key);
    expect(dump).not.toMatch(/Bearer a{30}/);
    expect(dump).toContain('[REDACTED]');
  });

  test('shutdown is bounded when a sink never flushes (offline backend)', async () => {
    tracer.addSink({ onSpanEnd() {}, shutdown: () => new Promise(() => {}) });
    const t0 = Date.now();
    await tracer.shutdown({ timeoutMs: 100 });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test('a rejecting or throwing sink shutdown does not break shutdown', async () => {
    tracer.addSink({ onSpanEnd() {}, shutdown: async () => { throw new Error('down'); } });
    tracer.addSink({ onSpanEnd() {}, shutdown: () => { throw new Error('sync down'); } });
    await expect(tracer.shutdown({ timeoutMs: 500 })).resolves.toBeUndefined();
  });

  test('initFromEnv: no sinks when disabled, no throw on unwritable trace path', () => {
    expect(tracer.initFromEnv({ TRACE_FILE: 'off' })).toEqual([]);
    const blocker = path.join(os.tmpdir(), `trace-blocker-${Date.now()}`);
    fs.writeFileSync(blocker, 'a file where a directory is needed');
    try {
      expect(tracer.initFromEnv({ TRACE_FILE: path.join(blocker, 'sub', 'traces.jsonl') })).toEqual([]);
    } finally { fs.rmSync(blocker, { force: true }); }
  });

  test('Langfuse configured but unreachable (real Node process): init ok, traces work, shutdown bounded', () => {
    // run outside Jest: the Langfuse SDK needs native dynamic import
    const script = `
      const tracer = require('./src/observability/tracer');
      (async () => {
        const names = tracer.initFromEnv({ TRACE_FILE: 'off', LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test', LANGFUSE_BASEURL: 'http://127.0.0.1:1' });
        const out = await tracer.trace('offline', { id: 'T-offline' }, () => tracer.span('child', {}, async () => 'ok'));
        const t0 = Date.now();
        await tracer.shutdown({ timeoutMs: 3000 });
        console.log('RESULT' + JSON.stringify({ names, out, shutdownMs: Date.now() - t0 }));
        process.exit(0);
      })();`;
    const r = require('child_process').spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT'));
    expect(line).toBeDefined();
    const res = JSON.parse(line.slice(6));
    expect(res.names).toEqual(['langfuse']);
    expect(res.out).toBe('ok');
    expect(res.shutdownMs).toBeLessThan(5000);
  });

  test('jsonl sink writes one parseable JSON line per span', async () => {
    const file = path.join(os.tmpdir(), `traces-${Date.now()}.jsonl`);
    tracer.resetSinks();
    tracer.addSink(tracer.jsonlSink(file));
    await tracer.trace('root', { id: 'J1' }, () => tracer.span('child', {}, async () => {}));
    await new Promise((r) => setTimeout(r, 100)); // appendFile is async
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.name).sort()).toEqual(['child', 'root']);
    expect(new Set(lines.map((l) => l.traceId))).toEqual(new Set(['J1']));
    fs.rmSync(file, { force: true });
  });
});
