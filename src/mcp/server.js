#!/usr/bin/env node
'use strict';

/**
 * MCP server for the AI Factory (stdio transport).
 *
 * Tools:
 *   validate_code       static + runtime quality checks on a module
 *   run_unit_tests      install + run a project's tests in the Docker sandbox
 *   list_project_files  list files under the configured workspace (read-only)
 *   read_project_file   read one file under the workspace (read-only, size-capped)
 *
 * Permissions: only tools named in MCP_ALLOWED_TOOLS (comma list) are registered,
 * so everything else is not even discoverable. Default allow-list is the three
 * side-effect-free tools; `run_unit_tests` must be enabled explicitly because it
 * spawns containers. MCP_WORKSPACE scopes the file tools.
 *
 * stdout carries the protocol, so logs go to stderr.
 */

process.env.LOG_TO_STDERR = 'true';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const tools = require('./tools');

const DEFAULT_ALLOWED = ['validate_code', 'list_project_files', 'read_project_file'];

const fileSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(512 * 1024),
});

const DEFINITIONS = [
  {
    name: 'validate_code',
    title: 'Validate module code',
    description: 'Run static analysis and sandboxed runtime checks on a generated JavaScript module. Returns a 0-100 score and a list of issues.',
    inputSchema: {
      code: z.string().min(1).max(200 * 1024).describe('JavaScript source of the module'),
      moduleName: z.string().min(1).max(100),
      requirements: z.string().max(5000).optional().describe('What the module is supposed to do'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => tools.validateCode(args),
  },
  {
    name: 'run_unit_tests',
    title: 'Run project tests in sandbox',
    description: 'Write the given files to a throw-away Docker container, npm install (no lifecycle scripts) and run jest with the network disabled. Returns structured test results and failures.',
    inputSchema: { files: z.array(fileSchema).min(1).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (args) => tools.runUnitTests(args),
  },
  {
    name: 'list_project_files',
    title: 'List project files',
    description: 'List files in the configured workspace, optionally under a sub-directory. Read-only.',
    inputSchema: { dir: z.string().max(300).optional().describe('Sub-directory relative to the workspace root') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, ctx) => tools.listProjectFiles(args, ctx),
  },
  {
    name: 'read_project_file',
    title: 'Read project file',
    description: 'Read one text file from the configured workspace. Paths that escape the workspace are rejected. Read-only.',
    inputSchema: { path: z.string().min(1).max(300).describe('File path relative to the workspace root') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, ctx) => tools.readProjectFile(args, ctx),
  },
];

function parseAllowed(env = process.env) {
  const raw = env.MCP_ALLOWED_TOOLS;
  if (!raw) return DEFAULT_ALLOWED;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function createServer({ allowed = parseAllowed(), workspace = process.env.MCP_WORKSPACE } = {}) {
  const server = new McpServer({ name: 'ai-factory', version: '1.0.0' });
  const ctx = { workspace };

  for (const def of DEFINITIONS) {
    if (!allowed.includes(def.name)) continue;
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
      async (args) => {
        try {
          const result = await def.run(args, ctx);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: `${err.name || 'Error'}: ${err.message}` }] };
        }
      },
    );
  }
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.connect(new StdioServerTransport()).catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createServer, parseAllowed, DEFAULT_ALLOWED };
