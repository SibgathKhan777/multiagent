#!/usr/bin/env node
'use strict';

/**
 * MCP server for the AI Factory (stdio transport).
 *
 * Tools (read-only unless marked SENSITIVE):
 *   get_task_status        pipeline task + module status and verdict (MongoDB)
 *   get_validation_report  per-module scores, issues and feedback rounds (MongoDB)
 *   inspect_project_files  list / read a task's generated files (MongoDB)
 *   validate_code          static + sandboxed runtime quality checks on a module
 *   list_project_files     list files under the configured workspace
 *   read_project_file      read one file under the workspace (size-capped)
 *   run_unit_tests         SENSITIVE: install + test supplied files in the Docker sandbox
 *   run_project_tests      SENSITIVE: install + test a task's generated project in the sandbox
 *
 * Permissions (least privilege):
 *  - only tools named in MCP_ALLOWED_TOOLS are registered (not even discoverable otherwise);
 *    the default is the read-only tools, SENSITIVE ones must be enabled explicitly
 *  - SENSITIVE tools additionally need a per-call approval token minted by the trusted
 *    MCP client (see approval.js). If MCP_APPROVAL_SECRET is missing they are NOT
 *    registered. MCP_REQUIRE_APPROVAL=false disables this (unsafe; for local experiments)
 *  - MCP_WORKSPACE scopes the file tools; there is no shell tool
 *
 * stdout carries the protocol, so logs go to stderr.
 */

process.env.LOG_TO_STDERR = 'true';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const tools = require('./tools');
const taskTools = require('./taskTools');
const { verifyApproval } = require('./approval');

const DEFAULT_ALLOWED = ['get_task_status', 'get_validation_report', 'inspect_project_files', 'validate_code', 'list_project_files', 'read_project_file'];
const taskIdSchema = z.string().regex(/^[0-9a-fA-F-]{8,64}$/, 'taskId must be the id returned by POST /api/pipeline').describe('Pipeline task id');
const approvalSchema = z.string().max(200).optional().describe('Approval token minted by the MCP host; the model cannot create one');

const fileSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(512 * 1024),
});

const DEFINITIONS = [
  {
    name: 'get_task_status',
    title: 'Get pipeline task status',
    description: 'Status, verdict (verified/unverified/failed) with reasons, module states and scores, and sandbox test summary for a pipeline task.',
    inputSchema: { taskId: taskIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => taskTools.getTaskStatus(args),
  },
  {
    name: 'get_validation_report',
    title: 'Get validation report',
    description: 'Per-module validation outcome: final score, whether it ever passed, iterations used, and the issues reported in each feedback round.',
    inputSchema: { taskId: taskIdSchema, moduleName: z.string().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => taskTools.getValidationReport(args),
  },
  {
    name: 'inspect_project_files',
    title: 'Inspect generated project files',
    description: 'List the files generated for a task, or return one file by path. Read-only; paths are validated.',
    inputSchema: { taskId: taskIdSchema, path: z.string().min(1).max(300).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args) => taskTools.inspectProjectFiles(args),
  },
  {
    name: 'run_project_tests',
    title: 'Run a task\'s generated tests in the sandbox',
    description: 'SENSITIVE (needs host approval). Install and run the generated project\'s tests for a task inside a Docker container with the network disabled for the tests.',
    inputSchema: { taskId: taskIdSchema, approval: approvalSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    sensitive: true,
    run: (args) => taskTools.runProjectTests(args),
  },
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
    inputSchema: { files: z.array(fileSchema).min(1).max(200), approval: approvalSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    sensitive: true,
    run: (args) => tools.runUnitTests({ files: args.files }),
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

function createServer({
  allowed = parseAllowed(),
  workspace = process.env.MCP_WORKSPACE,
  approvalSecret = process.env.MCP_APPROVAL_SECRET,
  requireApproval = process.env.MCP_REQUIRE_APPROVAL !== 'false',
} = {}) {
  const server = new McpServer({ name: 'ai-factory', version: '1.0.0' });
  const ctx = { workspace };

  for (const def of DEFINITIONS) {
    if (!allowed.includes(def.name)) continue;
    const gated = def.sensitive && requireApproval;
    if (gated && !approvalSecret) {
      console.error(`MCP: sensitive tool "${def.name}" is allowed but MCP_APPROVAL_SECRET is not set — not registering it`);
      continue;
    }
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: def.annotations },
      async (args) => {
        try {
          if (gated) {
            const verdict = verifyApproval(approvalSecret, def.name, args);
            if (!verdict.ok) throw new Error(`ApprovalRequired: ${verdict.reason}`);
          }
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
