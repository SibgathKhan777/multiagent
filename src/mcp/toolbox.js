'use strict';

/**
 * Toolbox: the single place where the pipeline calls validation and test
 * execution. With MCP_ENABLED=true they go through the MCP server (discovered
 * tools, schema-validated arguments, allow-list); otherwise they call the
 * agents directly, exactly as before.
 */

const logger = require('../utils/logger').forAgent('Toolbox');

let mcp = null;        // McpToolClient singleton
let connecting = null;

const enabled = () => process.env.MCP_ENABLED === 'true';

async function getClient() {
  if (!mcp) {
    const { McpToolClient } = require('./client');
    mcp = new McpToolClient({
      allowedTools: ['validate_code', 'run_unit_tests'],
      workspace: process.env.MCP_WORKSPACE,
      // The pipeline controller is the trusted host and the operator opted in with
      // MCP_ENABLED=true, so it approves its own sandboxed test runs. An LLM-driven agent
      // must NOT reuse this approver — give it one that asks a human or enforces a policy.
      approver: async ({ tool }) => tool === 'run_unit_tests',
    });
  }
  if (!connecting) {
    connecting = mcp.connect().then((c) => {
      logger.info(`MCP connected, tools discovered: ${c.listTools().map((t) => t.name).join(', ')}`);
      return c;
    }).catch((err) => { connecting = null; mcp = null; throw err; });
  }
  return connecting;
}

async function validate({ code, moduleName, requirements = '' }) {
  if (!enabled()) return require('../agents/validator').validate({ code, moduleName, requirements });
  const client = await getClient();
  return client.callTool('validate_code', { code, moduleName, requirements }, { timeoutMs: 60000 });
}

async function execute({ files }) {
  if (!enabled()) return require('../agents/executor').execute({ files });
  const client = await getClient();
  const r = await client.callTool('run_unit_tests', { files: files.map(({ path, content }) => ({ path, content })) }, { timeoutMs: 600000 });
  return { ...r, logs: [], filesWritten: files.length };
}

async function close() {
  if (mcp) await mcp.close();
  mcp = null;
  connecting = null;
}

module.exports = { validate, execute, close, enabled };
