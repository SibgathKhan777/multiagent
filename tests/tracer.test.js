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
