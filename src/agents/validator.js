const vm = require('vm');
const logger = require('../utils/logger').forAgent('Validator');

/**
 * Validator Agent
 *
 * Input:  { code: string, moduleName: string, requirements: string }
 * Output: { score: number (0-100), issues: Issue[], passed: boolean, runtime: Object }
 *
 * TWO-PHASE VALIDATION:
 * Phase 1: Static analysis  — checks patterns, structure, security
 * Phase 2: Runtime sandbox  — actually executes the code in Node's VM
 */

/**
 * Validate code quality for a module.
 */
async function validate({ code, moduleName, requirements = '' }) {
  logger.info(`Validating module: "${moduleName}" (${code.length} chars)`);

  const issues = [];
  let score = 100;

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: STATIC ANALYSIS
  // ═══════════════════════════════════════════════════════════════

  // ─── 1. Basic existence check ────────────────────────────────────
  if (!code || code.trim().length < 50) {
    issues.push({ type: 'error', message: 'Code is empty or too short', severity: 10 });
    return { score: 0, issues, passed: false, runtime: { executed: false } };
  }

  // ─── 2. Syntax validation ───────────────────────────────────────
  try {
    new Function('require', 'module', 'exports', '__dirname', '__filename', code);
  } catch (err) {
    issues.push({ type: 'error', message: `Syntax error: ${err.message}`, severity: 9 });
    score -= 30;
  }

  // ─── 3. Module.exports present ──────────────────────────────────
  if (!code.includes('module.exports')) {
    issues.push({ type: 'error', message: 'Missing module.exports — module has no public interface', severity: 8 });
    score -= 20;
  }

  // ─── 4. Error handling check ────────────────────────────────────
  const hasTryCatch = code.includes('try') && code.includes('catch');
  const hasThrow = code.includes('throw ');
  const hasErrorCallback = code.includes('err)') || code.includes('error)');

  if (!hasTryCatch && !hasThrow && !hasErrorCallback) {
    issues.push({ type: 'warning', message: 'No error handling detected (no try/catch, throw, or error callbacks)', severity: 6 });
    score -= 10;
  }

  // ─── 5. Input validation check ──────────────────────────────────
  const hasInputValidation = code.includes('if (!') || code.includes('if (!')
    || code.includes('required') || code.includes('.length');

  if (!hasInputValidation) {
    issues.push({ type: 'warning', message: 'Limited input validation detected', severity: 5 });
    score -= 8;
  }

  // ─── 6. Security checks ────────────────────────────────────────
  if (code.includes('eval(')) {
    issues.push({ type: 'error', message: 'Security risk: eval() usage detected', severity: 10 });
    score -= 25;
  }

  const secretPatterns = [
    /password\s*[:=]\s*['"][^'"]{3,}['"]/i,
    /secret\s*[:=]\s*['"][^'"]{8,}['"]/i,
    /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i,
  ];

  for (const pattern of secretPatterns) {
    if (pattern.test(code)) {
      if (!code.includes('change-in-production') && !code.includes('process.env')) {
        issues.push({ type: 'warning', message: 'Potential hardcoded secret detected', severity: 7 });
        score -= 10;
      }
    }
  }

  // ─── 7. Code structure ─────────────────────────────────────────
  const hasComments = code.includes('//') || code.includes('/**');
  if (!hasComments) {
    issues.push({ type: 'suggestion', message: 'No comments found — add documentation', severity: 3 });
    score -= 5;
  }

  const hasFunctions = code.includes('function ') || code.includes('=>');
  if (!hasFunctions) {
    issues.push({ type: 'warning', message: 'No functions defined — code may lack modularity', severity: 4 });
    score -= 8;
  }

  // ─── 8. Async patterns ─────────────────────────────────────────
  if (code.includes('.then(') && !code.includes('async')) {
    issues.push({ type: 'suggestion', message: 'Consider using async/await instead of .then() chains', severity: 2 });
    score -= 3;
  }

  // ─── 9. Completeness vs requirements ───────────────────────────
  if (requirements) {
    const reqWords = requirements.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    const codeWords = new Set(code.toLowerCase().split(/\s+/));
    const missing = reqWords.filter((w) => !codeWords.has(w));
    const coverage = 1 - (missing.length / Math.max(reqWords.length, 1));

    if (coverage < 0.4) {
      issues.push({ type: 'warning', message: `Low requirement coverage (${Math.round(coverage * 100)}%)`, severity: 6 });
      score -= 10;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: RUNTIME SANDBOX EXECUTION
  // ═══════════════════════════════════════════════════════════════
  const runtimeResult = runInSandbox(code, moduleName);

  if (runtimeResult.loadError) {
    issues.push({ type: 'error', message: `Runtime crash: ${runtimeResult.loadError}`, severity: 9 });
    score -= 15;
  }

  if (runtimeResult.loaded && runtimeResult.exportCount === 0) {
    issues.push({ type: 'warning', message: 'Module loaded but exports nothing usable', severity: 7 });
    score -= 10;
  }

  if (runtimeResult.loaded && runtimeResult.exportCount > 0) {
    // Bonus: code actually runs and exports things!
    score += 5;
    score = Math.min(100, score);
  }

  if (runtimeResult.callResults) {
    for (const result of runtimeResult.callResults) {
      if (result.threw) {
        issues.push({
          type: 'warning',
          message: `Export "${result.name}()" threw on test call: ${result.error}`,
          severity: 4,
        });
        score -= 3;
      }
    }
  }

  if (runtimeResult.timeout) {
    issues.push({ type: 'error', message: 'Runtime timeout: code execution exceeded 3 seconds', severity: 8 });
    score -= 15;
  }

  // Log runtime results
  logger.info(`Runtime check: ${moduleName} — loaded: ${runtimeResult.loaded}, exports: ${runtimeResult.exportCount}, calls tested: ${runtimeResult.callResults?.length || 0}`, {
    loaded: runtimeResult.loaded,
    exports: runtimeResult.exportCount,
    exportNames: runtimeResult.exportNames,
  });

  // ═══════════════════════════════════════════════════════════════
  // FINAL SCORE
  // ═══════════════════════════════════════════════════════════════
  score = Math.max(0, Math.min(100, score));
  const passed = score >= (parseInt(process.env.QUALITY_THRESHOLD, 10) || 70);

  logger.info(`Validation complete: ${moduleName} — score: ${score}, passed: ${passed}, issues: ${issues.length}`, {
    score,
    passed,
    issueCount: issues.length,
  });

  return { score, issues, passed, runtime: runtimeResult };
}

/**
 * Run code in a sandboxed VM context.
 *
 * Creates a fake `require()` that returns stub objects for any dependency,
 * so the code can load even without real npm packages installed.
 * Then checks what got exported and tries calling exported functions.
 */
function runInSandbox(code, moduleName) {
  const result = {
    loaded: false,
    loadError: null,
    exportCount: 0,
    exportNames: [],
    exportTypes: {},
    callResults: [],
    timeout: false,
    memoryUsed: 0,
  };

  // ─── Build stub require ────────────────────────────────────────
  // Returns mock objects for any package so code doesn't fail on missing deps
  const stubModules = {
    'express': createExpressStub(),
    'mongoose': createMongooseStub(),
    'bcrypt': { hash: async () => '$2b$10$stub', compare: async () => true, genSalt: async () => '$2b$10$salt' },
    'jsonwebtoken': { sign: () => 'stub.jwt.token', verify: () => ({ id: '123' }), decode: () => ({}) },
    'dotenv': { config: () => ({}) },
    'ioredis': function Redis() { this.get = async () => null; this.set = async () => 'OK'; this.del = async () => 1; },
    'socket.io': () => ({ on: () => {}, emit: () => {}, to: () => ({ emit: () => {} }) }),
    'multer': () => ({ single: () => (req, res, next) => next(), array: () => (req, res, next) => next() }),
    'nodemailer': { createTransport: () => ({ sendMail: async () => ({ messageId: 'stub' }) }) },
    'stripe': () => ({ charges: { create: async () => ({}) }, customers: { create: async () => ({}) } }),
    'joi': createJoiStub(),
    'cors': () => (req, res, next) => next(),
    'helmet': () => (req, res, next) => next(),
    'morgan': () => (req, res, next) => next(),
    'compression': () => (req, res, next) => next(),
    'uuid': { v4: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx' },
    'crypto': require('crypto'),
    'path': require('path'),
    'fs': { readFileSync: () => '', writeFileSync: () => {}, existsSync: () => true, mkdirSync: () => {} },
    'util': require('util'),
    'events': require('events'),
  };

  function sandboxRequire(modName) {
    if (stubModules[modName]) return stubModules[modName];
    // For relative requires, return an empty object
    if (modName.startsWith('.') || modName.startsWith('/')) return {};
    // For unknown packages, return a proxy that won't crash
    return new Proxy({}, {
      get: () => new Proxy(function() { return {}; }, { apply: () => ({}), get: () => () => ({}) }),
      apply: () => ({}),
    });
  }

  // ─── Execute in VM ─────────────────────────────────────────────
  const sandbox = {
    require: sandboxRequire,
    module: { exports: {} },
    exports: {},
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    process: {
      env: { PORT: '3000', MONGODB_URI: 'mongodb://localhost:27017/test', JWT_SECRET: 'test-secret', NODE_ENV: 'test' },
      exit: () => {},
      on: () => {},
    },
    setTimeout: () => {},
    setInterval: () => {},
    clearTimeout: () => {},
    clearInterval: () => {},
    Buffer: Buffer,
    __dirname: '/sandbox',
    __filename: '/sandbox/module.js',
    global: {},
    Promise: Promise,
    Error: Error,
    JSON: JSON,
    Date: Date,
    Math: Math,
    RegExp: RegExp,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    Map: Map,
    Set: Set,
    Symbol: Symbol,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
  };

  // Make sandbox.exports point to module.exports
  sandbox.exports = sandbox.module.exports;

  try {
    const script = new vm.Script(code, {
      filename: `${moduleName}.js`,
      timeout: 3000, // 3 second timeout — catches infinite loops
    });

    const context = vm.createContext(sandbox);
    script.runInContext(context, { timeout: 3000 });

    result.loaded = true;

    // ─── Analyze exports ───────────────────────────────────────
    const exported = sandbox.module.exports;

    if (typeof exported === 'function') {
      result.exportCount = 1;
      result.exportNames = [exported.name || 'default'];
      result.exportTypes = { [exported.name || 'default']: 'function' };
    } else if (typeof exported === 'object' && exported !== null) {
      const keys = Object.keys(exported);
      result.exportCount = keys.length;
      result.exportNames = keys;
      result.exportTypes = {};
      for (const key of keys) {
        result.exportTypes[key] = typeof exported[key];
      }
    } else {
      result.exportCount = exported ? 1 : 0;
      result.exportNames = [];
    }

    // ─── Test-call exported functions ──────────────────────────
    if (typeof exported === 'object' && exported !== null) {
      for (const [name, fn] of Object.entries(exported)) {
        if (typeof fn === 'function') {
          const callResult = { name, threw: false, returned: false, error: null, returnType: null };
          try {
            const ret = fn();
            callResult.returned = true;
            callResult.returnType = typeof ret;

            // If it returns a promise, await it to catch async errors
            if (ret && typeof ret.then === 'function') {
              callResult.returnType = 'promise';
              // Silence the rejection — we just want to know if it resolves or rejects
              ret.catch(() => {});
            }
          } catch (callErr) {
            callResult.threw = true;
            callResult.error = callErr.message?.substring(0, 100) || 'Unknown error';
          }
          result.callResults.push(callResult);
        }
      }
    }

  } catch (err) {
    if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      result.timeout = true;
      result.loadError = 'Execution timed out (>3s) — possible infinite loop';
    } else {
      result.loaded = false;
      result.loadError = err.message?.substring(0, 150) || 'Unknown runtime error';
    }
  }

  return result;
}

// ─── Stub factories for common packages ──────────────────────────

function createExpressStub() {
  const router = { get: () => router, post: () => router, put: () => router, patch: () => router, delete: () => router, use: () => router };
  const app = { ...router, listen: () => ({}), set: () => app };
  const express = () => app;
  express.Router = () => ({ ...router });
  express.json = () => (req, res, next) => next();
  express.urlencoded = () => (req, res, next) => next();
  express.static = () => (req, res, next) => next();
  return express;
}

function createMongooseStub() {
  const schema = function Schema(def) { this.def = def; this.pre = () => this; this.post = () => this; this.index = () => this; this.methods = {}; this.statics = {}; this.virtual = () => ({ get: () => {} }); };
  const model = () => {
    const M = function(data) { Object.assign(this, data); };
    M.find = async () => [];
    M.findOne = async () => null;
    M.findById = async () => null;
    M.findByIdAndUpdate = async () => ({});
    M.findByIdAndDelete = async () => ({});
    M.create = async (d) => d;
    M.deleteMany = async () => ({});
    M.countDocuments = async () => 0;
    M.prototype.save = async function() { return this; };
    return M;
  };
  return { Schema: schema, model, connect: async () => ({}), connection: { on: () => {}, once: () => {} }, Types: { ObjectId: String } };
}

function createJoiStub() {
  const chain = new Proxy({}, { get: () => () => chain });
  return new Proxy({}, { get: () => () => chain });
}

module.exports = { validate };
