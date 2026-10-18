'use strict';

/** Tool selectors: scripted (mock) and a real Groq function-calling one (live). */

const { callWithRetry } = require('../../src/services/llmErrors');

const mocks = {
  // always right: picks what the scenario expects with its recorded arguments
  oracle: async ({ scenario }) => (scenario.acceptable.length ? { tool: scenario.acceptable[0], args: scenario.mockArgs || {} } : { tool: null }),
  // lazy model: calls list_project_files for everything
  naive: async () => ({ tool: 'list_project_files', args: {} }),
  // never calls a tool
  never: async () => ({ tool: null }),
  // right except it ignores arguments (omits required ones) on validate_code, and invents a tool once
  sloppy: async ({ scenario }) => {
    if (scenario.id === 'validate-inline') return { tool: 'validate_code', args: {} };
    if (scenario.id === 'destructive') return { tool: 'delete_files', args: { path: '.' } };
    return mocks.oracle({ scenario });
  },
};

function toOpenAiTools(mcpTools) {
  return mcpTools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

/** Groq chat-completions function calling. Only for provider=groq. */
function groqSelector({ apiKey, model, timeoutMs = 60000 }) {
  const Groq = require('groq-sdk');
  const client = new Groq({ apiKey });
  return async ({ request, tools }) => {
    const { value } = await callWithRetry(async () => client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: 'You are an assistant for a software project workspace. Use a provided tool only when it is needed and available for the request; otherwise answer directly without calling a tool.' },
        { role: 'user', content: request },
      ],
      tools: toOpenAiTools(tools),
      tool_choice: 'auto',
    }), { maxAttempts: 3, baseDelayMs: 1000, timeoutMs });
    const msg = value.choices[0]?.message;
    const usage = value.usage ? { input: value.usage.prompt_tokens || 0, output: value.usage.completion_tokens || 0 } : null;
    const call = msg?.tool_calls?.[0];
    if (!call) return { tool: null, usage };
    let args = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = { __malformed: call.function.arguments }; }
    return { tool: call.function.name, args, usage };
  };
}

module.exports = { mocks, groqSelector, toOpenAiTools };
