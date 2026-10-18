/**
 * MCP security + task tools. Protocol-level tests use the SDK's in-memory transport with
 * a fake database; the process-level ones spawn the real server over stdio.
 */

jest.mock('../src/models/Task', () => require('./helpers/fakeDb').taskModel());
jest.mock('../src/models/Module', () => require('./helpers/fakeDb').moduleModel());
jest.mock('../src/models/FeedbackLog', () => require('./helpers/fakeDb').plainModel());

const mongoose = require('mongoose');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const Task = require('../src/models/Task');
const ModuleModel = require('../src/models/Module');
const FeedbackLog = require('../src/models/FeedbackLog');
const { createServer } = require('../src/mcp/server');
const { signApproval, verifyApproval, TTL_MS } = require('../src/mcp/approval');
const taskTools = require('../src/mcp/taskTools');
const { McpToolClient } = require('../src/mcp/client');
const tracer = require('../src/observability/tracer');

jest.setTimeout(30000);

const TID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'test-secret-0123456789';

// pretend Mongo is connected so ensureDb() is a no-op (the models are fakes)
beforeAll(() => { Object.defineProperty(mongoose.connection, 'readyState', { get: () => 1, configurable: true }); });
afterAll(() => { delete mongoose.connection.readyState; });

beforeEach(() => {
  Task.reset(); ModuleModel.reset(); FeedbackLog.reset();
  Task.docs.push({
    taskId: TID, idea: 'demo', status: 'failed', error: 'x', resumeCount: 1, metadata: { totalModules: 2 },
    finalOutput: {
      outcome: { verdict: 'failed', reasons: ['1 module(s) did not pass validation'] },
      execution: { success: false, skipped: false, tests: { passed: 3, total: 4 } },
      files: [{ path: 'src/a.js', content: 'module.exports = 1;', module: 'A' }, { path: 'package.json', content: '{}', module: 'Package' }],
    },
  });
  ModuleModel.docs.push(
    { taskId: TID, moduleId: 'm1', name: 'Auth Module', type: 'authentication', status: 'completed', priority: 1, iteration: 2, qualityScore: 55, validationPassed: false, usedFallback: false },
    { taskId: TID, moduleId: 'm2', name: 'DB Module', type: 'database', status: 'completed', priority: 0, iteration: 0, qualityScore: 92, validationPassed: true, usedFallback: false },
  );
  FeedbackLog.docs.push({ taskId: TID, moduleId: 'm1', iteration: 0, previousScore: 40, issues: [{ type: 'error', message: 'Syntax error: x', severity: 9 }] });
});

async function connectInMemory(serverOpts) {
  const server = createServer(serverOpts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text).join('');
    return { isError: !!res.isError, text, data: res.isError ? null : JSON.parse(text) };
  };
  return { client, call, close: () => client.close() };
}

describe('approval tokens', () => {
  const args = { taskId: TID };
  test('round trip', () => {
    const approval = signApproval(SECRET, 'run_project_tests', args);
    expect(verifyApproval(SECRET, 'run_project_tests', { ...args, approval })).toEqual({ ok: true });
  });
  test.each([
    ['missing', undefined, 'approval required'],
    ['malformed', 'garbage', 'malformed'],
    ['wrong secret', 'WRONG', 'does not match'],
  ])('rejects %s token', (_n, tok, reason) => {
    const approval = tok === 'WRONG' ? signApproval('other-secret', 'run_project_tests', args) : tok;
    const v = verifyApproval(SECRET, 'run_project_tests', { ...args, approval });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(reason);
  });
  test('bound to the tool, the arguments and the time window', () => {
    const approval = signApproval(SECRET, 'run_project_tests', args);
    expect(verifyApproval(SECRET, 'run_unit_tests', { ...args, approval }).ok).toBe(false);          // other tool
    expect(verifyApproval(SECRET, 'run_project_tests', { taskId: 'ffffffff-0000', approval }).ok).toBe(false); // other args
    const old = signApproval(SECRET, 'run_project_tests', args, Date.now() - TTL_MS - 1000);
    expect(verifyApproval(SECRET, 'run_project_tests', { ...args, approval: old })).toMatchObject({ ok: false, reason: 'approval expired' });
    expect(verifyApproval('', 'run_project_tests', { ...args, approval }).ok).toBe(false);          // no secret configured
  });
});

describe('task tools through the MCP protocol (in-memory transport, fake DB)', () => {
  test('read-only task tools are discoverable by default; sensitive ones are not', async () => {
    const { client, close } = await connectInMemory({ approvalSecret: SECRET });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining(['get_task_status', 'get_validation_report', 'inspect_project_files']));
    expect(names).not.toContain('run_project_tests');
    expect(names).not.toContain('run_unit_tests');
    await close();
  });

  test('get_task_status returns status, verdict, reasons, modules and test summary', async () => {
    const { call, close } = await connectInMemory({ approvalSecret: SECRET });
    const r = await call('get_task_status', { taskId: TID });
    expect(r.data).toMatchObject({ status: 'failed', verdict: 'failed', resumeCount: 1, execution: { success: false, tests: { passed: 3, total: 4 } } });
    expect(r.data.reasons[0]).toMatch(/did not pass validation/);
    expect(r.data.modules.map((m) => m.name)).toEqual(['DB Module', 'Auth Module']); // by priority
    expect(r.data.modules.find((m) => m.name === 'Auth Module')).toMatchObject({ validationPassed: false, qualityScore: 55 });
    await close();
  });

  test('get_validation_report includes feedback rounds and filters by module', async () => {
    const { call, close } = await connectInMemory({ approvalSecret: SECRET });
    const r = await call('get_validation_report', { taskId: TID, moduleName: 'Auth Module' });
    expect(r.data.modules).toHaveLength(1);
    expect(r.data.modules[0]).toMatchObject({ finalScore: 55, iterations: 3 });
    expect(r.data.modules[0].feedbackRounds[0].issues[0].message).toMatch(/Syntax error/);
    expect((await call('get_validation_report', { taskId: TID, moduleName: 'Nope' })).isError).toBe(true);
    await close();
  });

  test('inspect_project_files lists, reads, and rejects traversal', async () => {
    const { call, close } = await connectInMemory({ approvalSecret: SECRET });
    expect((await call('inspect_project_files', { taskId: TID })).data.files.map((f) => f.path)).toEqual(['src/a.js', 'package.json']);
    expect((await call('inspect_project_files', { taskId: TID, path: 'src/a.js' })).data.content).toBe('module.exports = 1;');
    for (const p of ['../../etc/passwd', '/etc/passwd', 'src\\..\\x', 'missing.js']) {
      expect((await call('inspect_project_files', { taskId: TID, path: p })).isError).toBe(true);
    }
    await close();
  });

  test('invalid input is rejected by schema; unknown task is a tool error', async () => {
    const { call, close } = await connectInMemory({ approvalSecret: SECRET });
    expect((await call('get_task_status', { taskId: 'not a uuid!' })).isError).toBe(true);
    expect((await call('get_task_status', {})).isError).toBe(true);
    const missing = await call('get_task_status', { taskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/Task not found/);
    await close();
  });
});

describe('sensitive tools: server-side approval enforcement', () => {
  const allowed = ['run_project_tests', 'run_unit_tests', 'get_task_status'];

  test('not registered at all when no approval secret is configured (fail closed)', async () => {
    const { client, close } = await connectInMemory({ allowed, approvalSecret: undefined });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['get_task_status']);
    await close();
  });

  test('calls without a valid token are refused and nothing is executed', async () => {
    const { call, close } = await connectInMemory({ allowed, approvalSecret: SECRET });
    for (const approval of [undefined, 'junk', signApproval('attacker-secret', 'run_project_tests', { taskId: TID })]) {
      const r = await call('run_project_tests', { taskId: TID, ...(approval ? { approval } : {}) });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/ApprovalRequired/);
    }
    const files = await call('run_unit_tests', { files: [{ path: 'a.js', content: '1' }] });
    expect(files.isError).toBe(true);
    expect(files.text).toMatch(/ApprovalRequired/);
    await close();
  });

  test('a token minted for different arguments cannot be replayed', async () => {
    const { call, close } = await connectInMemory({ allowed, approvalSecret: SECRET });
    const tokenForOther = signApproval(SECRET, 'run_project_tests', { taskId: 'ffffffff-0000-0000-0000-000000000000' });
    const r = await call('run_project_tests', { taskId: TID, approval: tokenForOther });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not match/);
    await close();
  });

  test('requireApproval=false (explicitly unsafe) skips the token check', async () => {
    const { client, close } = await connectInMemory({ allowed: ['run_project_tests'], approvalSecret: undefined, requireApproval: false });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['run_project_tests']);
    await close();
  });
});

describe('taskTools.runProjectTests (injected sandbox)', () => {
  const deps = (execute) => ({ Task, Module: ModuleModel, FeedbackLog, execute, ensureDb: async () => {} });

  test('runs the stored project and returns structured results', async () => {
    const execute = jest.fn(async () => ({ success: false, skipped: false, installSuccess: true, tests: { total: 4, passed: 3, failed: 1, failures: [{ test: 't' }] }, errors: ['1 test failure(s)'], startup: { attempted: false } }));
    const r = await taskTools.runProjectTests({ taskId: TID }, deps(execute));
    expect(execute.mock.calls[0][0].files.map((f) => f.path)).toEqual(['src/a.js', 'package.json']);
    expect(r).toMatchObject({ success: false, tests: { total: 4, passed: 3 } });
  });

  test('tasks without generated files cannot be run', async () => {
    Task.docs[0].finalOutput = null;
    await expect(taskTools.runProjectTests({ taskId: TID }, deps(jest.fn()))).rejects.toThrow(/no generated files/);
  });

  test('database failure surfaces as a clear error', async () => {
    const failing = { ...deps(jest.fn()), ensureDb: async () => { throw new Error('Database unavailable: ECONNREFUSED'); } };
    await expect(taskTools.getTaskStatus({ taskId: TID }, failing)).rejects.toThrow(/Database unavailable/);
  });
});

describe('MCP client approval gate (real stdio server)', () => {
  const dead = 'unix:///nonexistent-docker.sock';
  let saved;
  beforeAll(() => { saved = process.env.DOCKER_HOST; process.env.DOCKER_HOST = dead; });
  afterAll(() => { if (saved === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = saved; });
  const files = [{ path: 'package.json', content: '{}' }];

  test('no approver → sensitive call refused client-side', async () => {
    const c = await new McpToolClient({ allowedTools: ['run_unit_tests'] }).connect();
    try {
      await expect(c.callTool('run_unit_tests', { files })).rejects.toMatchObject({ kind: 'approval-required' });
    } finally { await c.close(); }
  });

  test('approver says no → denied', async () => {
    const approver = jest.fn(async () => false);
    const c = await new McpToolClient({ allowedTools: ['run_unit_tests'], approver }).connect();
    try {
      await expect(c.callTool('run_unit_tests', { files })).rejects.toMatchObject({ kind: 'approval-denied' });
      expect(approver).toHaveBeenCalledWith(expect.objectContaining({ tool: 'run_unit_tests' }));
    } finally { await c.close(); }
  });

  test('approver says yes → executes (Docker unreachable here, so it reports skipped, not success)', async () => {
    const c = await new McpToolClient({ allowedTools: ['run_unit_tests'], approver: async () => true }).connect();
    try {
      const r = await c.callTool('run_unit_tests', { files }, { timeoutMs: 30000 });
      expect(r).toMatchObject({ success: false, skipped: true });
    } finally { await c.close(); }
  });

  test('bypassing the wrapper with a forged token is still refused by the server', async () => {
    const c = await new McpToolClient({ allowedTools: ['run_unit_tests'], approver: async () => true }).connect();
    try {
      for (const approval of [undefined, '123.abc', signApproval('guess', 'run_unit_tests', { files })]) {
        const res = await c.client.callTool({ name: 'run_unit_tests', arguments: { files, ...(approval ? { approval } : {}) } });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/ApprovalRequired/);
      }
    } finally { await c.close(); }
  });

  test('database unreachable → clear tool error through the full stack', async () => {
    const saveUri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/none?serverSelectionTimeoutMS=1500';
    const c = await new McpToolClient({ allowedTools: ['get_task_status'] }).connect();
    try {
      await expect(c.callTool('get_task_status', { taskId: TID }, { timeoutMs: 20000 })).rejects.toMatchObject({ kind: 'tool', message: expect.stringMatching(/Database unavailable/) });
    } finally {
      await c.close();
      if (saveUri === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = saveUri;
    }
  });

  test('tool calls are traced as spans, without the approval token', async () => {
    tracer.resetSinks();
    const mem = tracer.addSink(tracer.memorySink());
    const c = await new McpToolClient({ allowedTools: ['run_unit_tests'], approver: async () => true }).connect();
    try {
      await tracer.trace('agent-run', { id: 'MCP-T1' }, () => c.callTool('run_unit_tests', { files }, { timeoutMs: 30000 }));
    } finally { await c.close(); tracer.resetSinks(); }
    const span = mem.spans.find((x) => x.name === 'mcp.run_unit_tests');
    expect(span).toMatchObject({ traceId: 'MCP-T1', status: 'ok', metadata: { tool: 'run_unit_tests', sensitive: true } });
    expect(span.parentId).toBe(mem.spans.find((x) => x.name === 'agent-run').spanId);
    expect(JSON.stringify(mem.spans)).not.toMatch(/"approval"/);
  });
});
