'use strict';

/**
 * MCP client used by the agents. Spawns the AI Factory MCP server over stdio,
 * discovers its tools, and only lets callers invoke tools that were discovered
 * (client-side permission check on top of the server's allow-list).
 */

const crypto = require('crypto');
const path = require('path');
const { signApproval } = require('./approval');
const tracer = require('../observability/tracer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER_PATH = path.join(__dirname, 'server.js');

class McpToolError extends Error {
  constructor(message, { tool, kind }) {
    super(message);
    this.name = 'McpToolError';
    this.tool = tool;
    this.kind = kind; // 'tool' | 'not-allowed' | 'not-connected' | 'approval-required' | 'approval-denied'
  }
}

class McpToolClient {
  /**
   * @param {Object}   opts
   * @param {string[]} opts.allowedTools  passed to the server as MCP_ALLOWED_TOOLS
   * @param {string}   [opts.workspace]   passed to the server as MCP_WORKSPACE
   * @param {Function} [opts.approver]    async ({tool, args}) => boolean. Required to call any
   *                                      non-read-only tool; default is deny. The model never
   *                                      sees the approval secret, so it cannot approve itself.
   */
  constructor({ allowedTools, workspace, approver = null, serverPath = SERVER_PATH, defaultTimeoutMs = 30000 } = {}) {
    this.approver = approver;
    this.approvalSecret = crypto.randomBytes(32).toString('hex'); // lives in this process + the child's env only
    this.allowedTools = allowedTools;
    this.workspace = workspace;
    this.serverPath = serverPath;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.client = null;
    this.tools = new Map();
  }

  async connect() {
    if (this.client) return this;
    const env = {};
    if (this.allowedTools) env.MCP_ALLOWED_TOOLS = this.allowedTools.join(',');
    if (this.workspace) env.MCP_WORKSPACE = this.workspace;
    env.MCP_APPROVAL_SECRET = this.approvalSecret;
    for (const key of ['DOCKER_HOST', 'EXEC_IMAGE', 'EXEC_KEEP_WORKDIR', 'LOG_LEVEL', 'TMPDIR', 'MONGODB_URI', 'VALIDATOR_RUNTIME', 'EXEC_SANDBOX']) {
      if (process.env[key]) env[key] = process.env[key];
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.serverPath],
      env,
      stderr: process.env.MCP_DEBUG ? 'inherit' : 'ignore',
    });
    const client = new Client({ name: 'ai-factory-agent', version: '1.0.0' });
    await client.connect(transport);
    this.client = client;

    // Tool discovery: the agent only knows what the server advertises
    const { tools } = await client.listTools();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    return this;
  }

  /** Discovered tools: [{ name, description, inputSchema, annotations }] */
  listTools() {
    return [...this.tools.values()];
  }

  has(name) {
    return this.tools.has(name);
  }

  /** Call a discovered tool; returns the parsed JSON result or throws McpToolError. */
  async callTool(name, args = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (!this.client) throw new McpToolError('MCP client is not connected', { tool: name, kind: 'not-connected' });
    if (!this.tools.has(name)) {
      throw new McpToolError(`Tool "${name}" was not discovered on the MCP server (not allowed or unknown)`, { tool: name, kind: 'not-allowed' });
    }

    // Anything that is not read-only needs explicit approval from the host (not from the model)
    const sensitive = !this.tools.get(name).annotations?.readOnlyHint;
    let callArgs = args;
    if (sensitive) {
      if (!this.approver) {
        throw new McpToolError(`Tool "${name}" is not read-only and no approver is configured — refusing`, { tool: name, kind: 'approval-required' });
      }
      const approved = await this.approver({ tool: name, args, description: this.tools.get(name).description });
      if (!approved) throw new McpToolError(`Call to "${name}" was not approved`, { tool: name, kind: 'approval-denied' });
      callArgs = { ...args, approval: signApproval(this.approvalSecret, name, args) };
    }

    return tracer.span(`mcp.${name}`, { type: 'span', input: args, metadata: { tool: name, sensitive, timeoutMs } }, async (h) => {
      const res = await this.client.callTool({ name, arguments: callArgs }, undefined, { timeout: timeoutMs });
      const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (res.isError) {
        h.setMetadata({ toolError: true });
        throw new McpToolError(text || 'Tool failed', { tool: name, kind: 'tool' });
      }
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      h.setOutput(parsed);
      return parsed;
    });
  }

  async close() {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
      this.tools = new Map();
    }
  }
}

module.exports = { McpToolClient, McpToolError, SERVER_PATH };
