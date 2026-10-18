'use strict';

/**
 * Tool-selection eval: given a request and the tools DISCOVERED from the MCP server,
 * does the agent pick the right tool (or correctly pick none), with valid arguments,
 * and does execution through the MCP client behave (including refusing path escapes)?
 */

const { McpToolError } = require('../../src/mcp/client');

const isDeepSubset = (expected, actual) =>
  Object.entries(expected || {}).every(([k, v]) => actual && String(actual[k]) === String(v));

/** Decide whether a model-chosen call is correct, ignoring execution. */
function judgeSelection(scenario, choice) {
  const expectedNone = scenario.acceptable.length === 0;
  if (!choice || !choice.tool) {
    return { correct: expectedNone, kind: expectedNone ? 'correct_no_call' : 'missed_call' };
  }
  if (expectedNone) return { correct: false, kind: 'unnecessary_call' };
  if (!scenario.acceptable.includes(choice.tool)) return { correct: false, kind: 'wrong_tool' };
  if (scenario.expectArgs && !isDeepSubset(scenario.expectArgs, choice.args)) return { correct: false, kind: 'wrong_arguments' };
  return { correct: true, kind: 'correct_call' };
}

async function runScenario(scenario, { select, client }) {
  const tools = client.listTools();
  const started = Date.now();
  let choice;
  try {
    choice = await select({ request: scenario.request, tools, scenario });
  } catch (err) {
    return { id: scenario.id, providerError: err.llm?.kind || err.message.slice(0, 120), selection: { correct: false, kind: 'provider_error' }, latencyMs: Date.now() - started };
  }

  const selection = judgeSelection(scenario, choice);
  const rec = { id: scenario.id, chosen: choice?.tool || null, args: choice?.args || null, selection, usage: choice?.usage || null, latencyMs: Date.now() - started };

  if (choice?.tool) {
    const known = client.has(choice.tool);
    rec.discovered = known;
    if (known) {
      try {
        await client.callTool(choice.tool, choice.args || {});
        rec.execution = { ok: true };
      } catch (err) {
        const msg = String(err.message);
        rec.execution = {
          ok: false,
          rejected: err instanceof McpToolError && err.kind === 'tool',
          invalidArguments: /validation|invalid|required|expected/i.test(msg) && !/outside|escape|Absolute|Backslash/i.test(msg),
          message: msg.slice(0, 160),
        };
      }
    } else {
      rec.execution = { ok: false, rejected: true, invalidArguments: false, message: 'tool not discovered' };
    }
  }
  return rec;
}

const ratio = (n, d) => (d ? n / d : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarize(results, scenarios) {
  const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  const answered = results.filter((r) => !r.providerError);
  const calls = answered.filter((r) => r.chosen);
  const expectNone = answered.filter((r) => byId[r.id].acceptable.length === 0);
  // only attempts that actually reached the server with the escaping tool count
  const guardrail = answered.filter((r) => byId[r.id].expectRejected && r.chosen && byId[r.id].acceptable.includes(r.chosen));
  const legit = calls.filter((r) => !byId[r.id].expectRejected);
  const withUsage = answered.filter((r) => r.usage);

  const classes = {};
  for (const r of answered) if (!r.selection.correct) classes[r.selection.kind] = (classes[r.selection.kind] || 0) + 1;

  return {
    denominators: {
      scenarios: results.length,
      answered: answered.length,
      providerErrors: results.length - answered.length,
      toolCalls: calls.length,
      expectedNoCall: expectNone.length,
      guardrailScenarios: guardrail.length,
    },
    toolSelectionAccuracy: ratio(answered.filter((r) => r.selection.correct).length, answered.length),
    toolCallPrecision: ratio(calls.filter((r) => r.selection.correct).length, calls.length),
    unnecessaryCallRate: ratio(expectNone.filter((r) => r.chosen).length, expectNone.length),
    argumentValidityRate: ratio(calls.filter((r) => r.discovered && !(r.execution && r.execution.invalidArguments)).length, calls.length),
    toolExecutionSuccessRate: ratio(legit.filter((r) => r.execution?.ok).length, legit.length),
    // for requests that try to escape the workspace: the call was made but the server refused it
    guardrailHoldRate: ratio(guardrail.filter((r) => r.execution && !r.execution.ok && r.execution.rejected).length, guardrail.length),
    providerErrorRate: ratio(results.length - answered.length, results.length),
    failureClasses: classes,
    avgLatencyMs: mean(answered.map((r) => r.latencyMs)),
    avgInputTokens: withUsage.length ? mean(withUsage.map((r) => r.usage.input)) : null,
    avgOutputTokens: withUsage.length ? mean(withUsage.map((r) => r.usage.output)) : null,
  };
}

async function runToolsSuite({ scenarios, select, client, onScenario = () => {} }) {
  const results = [];
  for (const s of scenarios) {
    const r = await runScenario(s, { select, client });
    results.push(r);
    if (onScenario(r) === true) break;
  }
  return { results, summary: summarize(results, scenarios), failedCases: results.filter((r) => !r.selection.correct).map((r) => ({ id: r.id, class: r.selection.kind })) };
}

module.exports = { runToolsSuite, judgeSelection, summarize, runScenario };
