const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpToolClient, McpToolError } = require('../src/mcp/client');
const tools = require('../src/mcp/tools');
const { parseAllowed, DEFAULT_ALLOWED } = require('../src/mcp/server');

jest.setTimeout(30000);

// Keep these tests independent of whether the machine has Docker (CI runners do, laptops may not)
beforeAll(() => { process.env.VALIDATOR_RUNTIME = 'off'; process.env.EXEC_SANDBOX = 'off'; });
afterAll(() => { delete process.env.VALIDATOR_RUNTIME; delete process.env.EXEC_SANDBOX; });

const GOOD = "'use strict';\n// adds numbers\nfunction add(a, b) {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new Error('numbers required');\n  return a + b;\n}\nmodule.exports = { add };\n";

describe('MCP tools (in-process)', () => {
  let ws;
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ws-'));
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src/a.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(ws, 'secret-outside.txt'), 'x');
    fs.mkdirSync(path.join(ws, 'node_modules'));
    fs.writeFileSync(path.join(ws, 'node_modules/skip.js'), '');
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  test.each([undefined, '', '.', null])('list_project_files treats dir=%j as the workspace root (models send "" for "none")', async (dir) => {
    const r = await tools.listProjectFiles({ dir }, { workspace: ws });
    expect(r.files).toEqual(['secret-outside.txt', 'src/a.js']);
  });

  test('list_project_files skips node_modules', async () => {
    const r = await tools.listProjectFiles({}, { workspace: ws });
    expect(r.files).toEqual(['secret-outside.txt', 'src/a.js']);
  });

  test('read_project_file reads inside the workspace', async () => {
    expect((await tools.readProjectFile({ path: 'src/a.js' }, { workspace: ws })).content).toBe('module.exports = 1;');
  });

  test.each(['../etc/passwd', '/etc/passwd', 'src/../../x', 'node_modules/skip.js'])('read_project_file rejects %s', async (p) => {
    await expect(tools.readProjectFile({ path: p }, { workspace: ws })).rejects.toThrow();
  });

  test('read_project_file rejects symlinks that point outside the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-out-'));
    fs.writeFileSync(path.join(outside, 'loot.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'loot.txt'), path.join(ws, 'link.txt'));
    await expect(tools.readProjectFile({ path: 'link.txt' }, { workspace: ws })).rejects.toThrow(/outside the workspace/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('file tools require a workspace', async () => {
    await expect(tools.listProjectFiles({}, { workspace: undefined })).rejects.toThrow(/MCP_WORKSPACE/);
  });
});

describe('permissions', () => {
  test('default allow-list excludes run_unit_tests', () => {
    expect(parseAllowed({})).toEqual(DEFAULT_ALLOWED);
    expect(DEFAULT_ALLOWED).not.toContain('run_unit_tests');
    expect(parseAllowed({ MCP_ALLOWED_TOOLS: 'a, b' })).toEqual(['a', 'b']);
  });
});

describe('MCP over real stdio (client ↔ server process)', () => {
  let ws, client;
  beforeAll(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ws-'));
    fs.writeFileSync(path.join(ws, 'hello.txt'), 'hi');
    client = await new McpToolClient({ workspace: ws }).connect(); // default allow-list
  });
  afterAll(async () => { await client.close(); fs.rmSync(ws, { recursive: true, force: true }); });

  test('discovers only allowed tools, with schemas', () => {
    const names = client.listTools().map((t) => t.name).sort();
    expect(names).toEqual(['get_task_status', 'get_validation_report', 'inspect_project_files', 'list_project_files', 'read_project_file', 'validate_code']);
    const v = client.listTools().find((t) => t.name === 'validate_code');
    expect(v.inputSchema.required).toEqual(expect.arrayContaining(['code', 'moduleName']));
    expect(v.annotations.readOnlyHint).toBe(true);
  });

  test('run_unit_tests is not discoverable or callable by default', async () => {
    expect(client.has('run_unit_tests')).toBe(false);
    expect(client.has('run_project_tests')).toBe(false);
    await expect(client.callTool('run_unit_tests', { files: [{ path: 'a', content: '' }] })).rejects.toMatchObject({ kind: 'not-allowed' });
  });

  test('validate_code returns a structured result', async () => {
    const r = await client.callTool('validate_code', { code: GOOD, moduleName: 'Math' }, { timeoutMs: 20000 });
    expect(r.passed).toBe(true);
    expect(r.score).toBeGreaterThan(70);
  });

  test('validate_code reports issues for bad code', async () => {
    const r = await client.callTool('validate_code', { code: 'function (( {{ not js at all ' + 'x'.repeat(60), moduleName: 'Bad' }, { timeoutMs: 20000 });
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => /Syntax error/.test(i.message))).toBe(true);
  });

  test('malformed arguments are rejected by schema validation', async () => {
    await expect(client.callTool('validate_code', { code: 123 })).rejects.toBeInstanceOf(McpToolError);
    await expect(client.callTool('read_project_file', {})).rejects.toBeInstanceOf(McpToolError);
  });

  test('file tools work and enforce the workspace boundary', async () => {
    expect((await client.callTool('read_project_file', { path: 'hello.txt' })).content).toBe('hi');
    expect((await client.callTool('list_project_files', {})).files).toEqual(['hello.txt']);
    await expect(client.callTool('read_project_file', { path: '../../etc/passwd' })).rejects.toMatchObject({ kind: 'tool' });
  });

  test('tool failures surface as McpToolError, not protocol crashes', async () => {
    await expect(client.callTool('read_project_file', { path: 'missing.txt' })).rejects.toMatchObject({ name: 'McpToolError', kind: 'tool' });
    // server still alive afterwards
    expect((await client.callTool('read_project_file', { path: 'hello.txt' })).content).toBe('hi');
  });
});

describe('MCP with run_unit_tests enabled', () => {
  test('is discoverable only when explicitly allowed', async () => {
    const c = await new McpToolClient({ allowedTools: ['run_unit_tests'] }).connect();
    try {
      expect(c.listTools().map((t) => t.name)).toEqual(['run_unit_tests']);
      expect(c.listTools()[0].annotations.readOnlyHint).toBe(false);
    } finally { await c.close(); }
  });
});

describe('toolbox routing', () => {
  afterEach(() => { delete process.env.MCP_ENABLED; });

  test('MCP_ENABLED=true routes validation through the MCP server', async () => {
    process.env.MCP_ENABLED = 'true';
    const toolbox = require('../src/mcp/toolbox');
    try {
      const r = await toolbox.validate({ code: GOOD, moduleName: 'Math' });
      expect(r.passed).toBe(true);
    } finally { await toolbox.close(); }
  });

  test('default path calls the agent directly (no subprocess)', async () => {
    const toolbox = require('../src/mcp/toolbox');
    expect(toolbox.enabled()).toBe(false);
    const r = await toolbox.validate({ code: GOOD, moduleName: 'Math' });
    expect(r.passed).toBe(true);
  });

  test('MCP_ENABLED=true routes sandboxed tests through run_unit_tests with host approval (sandbox disabled → skipped)', async () => {
    process.env.EXEC_SANDBOX = 'off';
    process.env.MCP_ENABLED = 'true';
    const toolbox = require('../src/mcp/toolbox');
    try {
      const r = await toolbox.execute({ files: [{ path: 'package.json', content: '{}' }] });
      expect(r).toMatchObject({ success: false, skipped: true });
    } finally {
      await toolbox.close();
      delete process.env.EXEC_SANDBOX;
    }
  });
});
