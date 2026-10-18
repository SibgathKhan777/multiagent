'use strict';

/**
 * Scripted "models" for deterministic evals — no network, no API key, no cost.
 * Each returns a provider function compatible with worker.executeWork's `providers` dep:
 *   (prompt, tier, moduleContext) => { code, usage, model }
 * moduleContext.name is the task id and moduleContext.iteration the attempt number.
 */

const reference = require('./reference');
const { extractCode } = require('../../src/agents/worker');

const wrongAnswer = (id) => `// deliberately wrong: always returns undefined\nfunction ${id}() { return undefined; }\nmodule.exports = { ${id} };`;
const syntaxBroken = () => `// deliberately broken\nfunction ((( {{{\nmodule.exports = {`;

const usage = (prompt, code) => ({ input: Math.ceil(prompt.length / 4), output: Math.ceil(code.length / 4) });
const reply = (prompt, code) => ({ code: extractCode(code), usage: usage(prompt, code), model: 'mock' });

const behaviours = {
  perfect: (prompt, _t, ctx) => reply(prompt, reference[ctx.name]),
  // wrong on the first attempt, correct once it has seen the failing cases
  flaky: (prompt, _t, ctx) => reply(prompt, ctx.iteration === 0 ? wrongAnswer(ctx.name) : reference[ctx.name]),
  wrong: (prompt, _t, ctx) => reply(prompt, wrongAnswer(ctx.name)),
  broken: (prompt) => reply(prompt, syntaxBroken()),
  empty: () => reply('', ''),
  outage: () => { throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); },
};

/** Deterministic mix across tasks: perfect, flaky, wrong, broken, perfect, ... (by task index) */
function mixed(order) {
  const cycle = ['perfect', 'flaky', 'wrong', 'broken', 'perfect'];
  return (prompt, tier, ctx) => behaviours[cycle[order.indexOf(ctx.name) % cycle.length]](prompt, tier, ctx);
}

function makeMockProvider(behaviour, taskIds) {
  if (behaviour === 'mixed') return mixed(taskIds);
  if (!behaviours[behaviour]) throw new Error(`Unknown mock behaviour "${behaviour}" (have: ${Object.keys(behaviours).concat('mixed').join(', ')})`);
  return behaviours[behaviour];
}

module.exports = { makeMockProvider, behaviours };
