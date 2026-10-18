'use strict';

/**
 * MCP client used by the agents. Spawns the AI Factory MCP server over stdio,
 * discovers its tools, and only lets callers invoke tools that were discovered
 * (client-side permission check on top of the server's allow-list).
 */

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER_PATH = path.join(__dirname, 'server.js');

class McpToolError extends Error {
  constructor(message, { tool, kind }) {
    super(message);
    this.name = 'McpToolError';
    this.tool = tool;
    this.kind = kind; // 'tool' (the tool reported an error) | 'not-allowed' | 'not-connected'
  }
}

class McpToolClient {
  /**
   * @param {Object}   opts
   * @param {string[]} opts.allowedTools  passed to the server as MCP_ALLOWED_TOOLS
   * @param {string}   [opts.workspace]   passed to the server as MCP_WORKSPACE
   */
  constructor({ allowedTools, workspace, serverPath = SERVER_PATH, defaultTimeoutMs = 30000 } = {}) {
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
    for (const key of ['DOCKER_HOST', 'EXEC_IMAGE', 'EXEC_KEEP_WORKDIR', 'LOG_LEVEL', 'TMPDIR']) {
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

    const res = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res.isError) throw new McpToolError(text || 'Tool failed', { tool: name, kind: 'tool' });
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
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
