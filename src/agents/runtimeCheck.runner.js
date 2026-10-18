#!/usr/bin/env node
'use strict';

/**
 * Runtime check runner — executes ONE generated module inside Node's vm with
 * stubbed dependencies and prints a JSON summary.
 *
 * !! This file must only ever run INSIDE the Docker sandbox (see runtimeCheck.js). !!
 * Node's vm is not a security boundary: generated code can escape it (e.g. via
 * Object.constructor) and gets full control of this process. The container
 * (no network, read-only fs, non-root, resource limits) is the boundary.
 *
 * Usage: node runtimeCheck.runner.js <codeFile> <moduleName>
 * Output: one line "__RUNTIME_RESULT__{json}" on stdout.
 */

const fs = require('fs');
const vm = require('vm');

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


if (require.main === module) {
  const [codeFile, moduleName = 'module'] = process.argv.slice(2);
  const code = fs.readFileSync(codeFile, 'utf8');
  const result = runInSandbox(code, moduleName);
  process.stdout.write('__RUNTIME_RESULT__' + JSON.stringify(result) + '\n');
  process.exit(0);
}

module.exports = { runInSandbox };
