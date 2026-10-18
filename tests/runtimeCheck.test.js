const { runtimeCheck, resetAvailabilityCache } = require('../src/agents/runtimeCheck');

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };

beforeEach(() => resetAvailabilityCache());

describe('runtimeCheck (Docker)', () => {
  test('skips when Docker is unavailable and never spawns a run', async () => {
    const calls = [];
    const runner = async (cmd, args) => { calls.push(args); return { ...ok, code: 1 }; };
    const r = await runtimeCheck({ code: 'module.exports = {}', moduleName: 'M' }, { runner });
    expect(r).toMatchObject({ executed: false });
    expect(r.reason).toMatch(/Docker unavailable/);
    expect(calls).toHaveLength(1); // only `docker info`
  });

  test('runs in a locked-down container and parses the result marker', async () => {
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push(args);
      if (args[0] === 'info') return ok;
      return { ...ok, stdout: 'noise\n__RUNTIME_RESULT__' + JSON.stringify({ loaded: true, exportCount: 1, exportNames: ['a'], callResults: [] }) + '\n' };
    };
    const r = await runtimeCheck({ code: 'module.exports = { a(){} }', moduleName: 'M' }, { runner });
    expect(r).toMatchObject({ executed: true, loaded: true, exportCount: 1 });
    const run = calls.find((a) => a[0] === 'run');
    expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--read-only', '--pids-limit']));
    expect(run[run.indexOf('--network') + 1]).toBe('none');
    expect(run.some((a) => String(a).endsWith(':/work:ro'))).toBe(true);
  });

  test('reports a timeout as a failed load, not a skip', async () => {
    const runner = async (cmd, args) => (args[0] === 'info' ? ok : { ...ok, code: null, timedOut: true });
    const r = await runtimeCheck({ code: 'while(true){}', moduleName: 'M' }, { runner });
    expect(r).toMatchObject({ executed: true, loaded: false, timeout: true });
  });

  test('missing result line is treated as not executed, not as success', async () => {
    const runner = async () => ok;
    resetAvailabilityCache();
    const r = await runtimeCheck({ code: 'x', moduleName: 'M' }, { runner });
    expect(r.executed).toBe(false);
  });

  test('rejects oversized code without touching Docker', async () => {
    const runner = jest.fn();
    const r = await runtimeCheck({ code: 'x'.repeat(600 * 1024), moduleName: 'M' }, { runner });
    expect(r.executed).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
