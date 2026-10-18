const { validate: rawValidate } = require('../src/agents/validator');
const { localRuntimeCheck } = require('./helpers/localRuntimeCheck');

// Tests inject a host-side runtime check (fixed snippets only); production uses the Docker one.
const validate = (args) => rawValidate(args, { runtimeCheck: localRuntimeCheck });

describe('Validator Agent', () => {
  const goodCode = `
'use strict';
const express = require('express');

/**
 * Process an order.
 * @param {Object} order
 * @returns {Object}
 */
async function processOrder(order) {
  try {
    if (!order || !order.items) {
      throw new Error('Invalid order: items required');
    }
    const total = order.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    return { success: true, total };
  } catch (err) {
    throw err;
  }
}

module.exports = { processOrder };
  `.trim();

  // ─── Static Analysis Tests ─────────────────────────────────────

  test('validates good code with high score', async () => {
    const result = await validate({ code: goodCode, moduleName: 'Test', requirements: '' });

    expect(result.score).toBeGreaterThan(70);
    expect(result.passed).toBe(true);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  test('flags empty code', async () => {
    const result = await validate({ code: '', moduleName: 'Empty', requirements: '' });

    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].type).toBe('error');
  });

  test('flags missing module.exports', async () => {
    const code = `
'use strict';
// A module that does something useful but forgets to export
function fetchUsers() {
  const users = [];
  for (let i = 0; i < 10; i++) {
    users.push({ id: i, name: 'User ' + i });
  }
  return users;
}

function filterActive(users) {
  return users.filter(u => u.id > 5);
}
    `.trim();
    const result = await validate({ code, moduleName: 'NoExport', requirements: '' });

    expect(result.issues.some((i) => i.message.includes('module.exports'))).toBe(true);
  });

  test('flags eval() usage', async () => {
    const code = `
'use strict';
// Dangerous code that uses eval
function compute(expression) {
  if (!expression || typeof expression !== 'string') {
    throw new Error('Expression required');
  }
  try {
    const result = eval(expression);
    return { success: true, result };
  } catch (err) {
    throw new Error('Invalid expression');
  }
}

module.exports = { compute };
    `.trim();
    const result = await validate({ code, moduleName: 'Eval', requirements: '' });

    expect(result.issues.some((i) => i.message.includes('eval'))).toBe(true);
    expect(result.score).toBeLessThan(80);
  });

  test('flags no error handling', async () => {
    const code = `
'use strict';
// Simple utility with no error handling at all
function add(a, b) { return a + b; }
function multiply(a, b) { return a * b; }
function divide(a, b) { return a / b; }
module.exports = { add, multiply, divide };
    `.trim();
    const result = await validate({ code, moduleName: 'NoErrors', requirements: '' });

    expect(result.issues.some((i) => i.message.toLowerCase().includes('error handling'))).toBe(true);
  });

  test('returns score between 0 and 100', async () => {
    const result = await validate({ code: goodCode, moduleName: 'Test', requirements: '' });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  // ─── Runtime Sandbox Tests ─────────────────────────────────────

  test('runtime: successfully loads and detects exports', async () => {
    const result = await validate({ code: goodCode, moduleName: 'RuntimeTest', requirements: '' });

    expect(result.runtime).toBeDefined();
    expect(result.runtime.loaded).toBe(true);
    expect(result.runtime.exportCount).toBeGreaterThan(0);
    expect(result.runtime.exportNames).toContain('processOrder');
    expect(result.runtime.exportTypes.processOrder).toBe('function');
  });

  test('runtime: test-calls exported functions', async () => {
    const code = `
'use strict';
/**
 * Add two numbers
 * @param {number} a
 * @param {number} b
 */
function add(a, b) {
  try {
    if (typeof a !== 'number') return 0;
    return (a || 0) + (b || 0);
  } catch (err) {
    return 0;
  }
}

function greet(name) {
  if (!name) return 'Hello!';
  return 'Hello ' + name;
}

module.exports = { add, greet };
    `.trim();

    const result = await validate({ code, moduleName: 'CallTest', requirements: '' });

    expect(result.runtime.loaded).toBe(true);
    expect(result.runtime.exportCount).toBe(2);
    expect(result.runtime.callResults.length).toBe(2);

    // Functions should not throw when called with no args
    const addResult = result.runtime.callResults.find(r => r.name === 'add');
    expect(addResult.returned).toBe(true);
    expect(addResult.threw).toBe(false);
  });

  test('runtime: detects runtime crash', async () => {
    const code = `
'use strict';
// This code will crash at load time by calling an undefined function
/**
 * A broken module
 */
const data = nonExistentFunction();
module.exports = { data };
    `.trim();

    const result = await validate({ code, moduleName: 'CrashTest', requirements: '' });

    expect(result.runtime.loaded).toBe(false);
    expect(result.runtime.loadError).toBeTruthy();
    expect(result.issues.some(i => i.message.includes('Runtime crash'))).toBe(true);
  });

  test('runtime: handles modules with stubbed dependencies', async () => {
    const code = `
'use strict';
const express = require('express');
const mongoose = require('mongoose');

/**
 * User schema and model
 */
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
});

const User = mongoose.model('User', UserSchema);

/**
 * Get all users
 */
async function getUsers() {
  try {
    return await User.find();
  } catch (err) {
    throw new Error('Failed to fetch users');
  }
}

module.exports = { User, getUsers };
    `.trim();

    const result = await validate({ code, moduleName: 'StubTest', requirements: '' });

    expect(result.runtime.loaded).toBe(true);
    expect(result.runtime.exportNames).toContain('User');
    expect(result.runtime.exportNames).toContain('getUsers');
  });

  test('runtime check skipped (e.g. no Docker): reported, no bonus/penalty, never run on host', async () => {
    const skipped = async () => ({ executed: false, reason: 'Docker unavailable' });
    const r = await rawValidate({ code: goodCode, moduleName: 'M', requirements: '' }, { runtimeCheck: skipped });
    expect(r.runtime.executed).toBe(false);
    expect(r.issues.some((i) => /Runtime check skipped/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /Runtime crash/.test(i.message))).toBe(false);
  });

  test('default runtime check never executes generated code on the host', async () => {
    const marker = require('path').join(require('os').tmpdir(), `pwned-${Date.now()}`);
    const evil = `'use strict';\n// escape attempt\nconst p = this.constructor.constructor('return process')();\np.mainModule.require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nmodule.exports = { a() {} };\n`;
    const { resetAvailabilityCache } = require('../src/agents/runtimeCheck');
    resetAvailabilityCache();
    process.env.VALIDATOR_RUNTIME = 'off';
    try {
      const r = await rawValidate({ code: evil, moduleName: 'Evil', requirements: '' });
      expect(r.runtime.executed).toBe(false);
      expect(require('fs').existsSync(marker)).toBe(false);
    } finally { delete process.env.VALIDATOR_RUNTIME; }
  });
});
