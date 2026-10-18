'use strict';

/**
 * Eval harness — runs one task through the real agents in-process
 * (no MongoDB / Redis / queue needed).
 *
 *   decompose → prompt → worker → validate → (feedback → retry) → integrate → sandbox
 *
 * NOTE: the build/validate/feedback loop mirrors processModule() in
 * src/core/controller.js. If one changes, change the other.
 *
 * All agents are injectable via `deps` so the harness can be unit-tested
 * with stubs and no API key.
 */

const { scoreDecomposition, requirementCoverage } = require('./metrics');

function defaultDeps() {
  return {
    decompose: require('../src/agents/decomposer').decompose,
    generatePrompt: require('../src/agents/promptGenerator').generatePrompt,
    executeWork: require('../src/agents/worker').executeWork,
    validate: require('../src/agents/validator').validate,
    generateFeedback: require('../src/agents/feedback').generateFeedback,
    integrate: require('../src/agents/integration').integrate,
    getFilePath: require('../src/agents/integration').getFilePath,
    execute: require('../src/agents/executor').execute,
    maxIterations: require('../config/default').pipeline.maxIterations,
  };
}

function exportNames(code) {
  const m = code.match(/module\.exports\s*=\s*\{([^}]+)\}/);
  if (m) return m[1].split(',').map((s) => s.trim().split(':')[0].split('(')[0].trim()).filter(Boolean);
  const single = code.match(/module\.exports\s*=\s*([A-Za-z_]\w*)/);
  return single ? [single[1]] : [];
}

async function runTask(task, { sandbox = true, deps: overrides = {} } = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const started = Date.now();
  const tokens = { input: 0, output: 0 };
  let tokensSeen = false;

  const modulesOut = [];
  const completed = new Map(); // name → { code, exports, filePath }

  const mods = await deps.decompose({ idea: task.idea });
  const decomposition = scoreDecomposition(task, mods.map((m) => m.name));

  for (const mod of mods) {
    const siblings = [...completed].map(([name, i]) => ({ name, exports: i.exports, filePath: i.filePath }));
    let { prompt } = await deps.generatePrompt({
      module: { name: mod.name, description: mod.description, type: mod.type, dependencies: mod.dependencies },
      context: task.idea,
      siblingModules: siblings,
    });

    const rec = { name: mod.name, iterations: 0, firstPassPassed: false, passed: false, score: 0, invalid: false, fallback: false };
    let code = '';
    for (let iteration = 0; iteration < deps.maxIterations; iteration++) {
      const work = await deps.executeWork({
        prompt, model: mod.assignedModel,
        moduleContext: { name: mod.name, type: mod.type, description: mod.description, dependencies: mod.dependencies, iteration },
      });
      code = work.code;
      rec.iterations = iteration + 1;
      rec.fallback = rec.fallback || !!work.fallback;
      if (work.usage) { tokensSeen = true; tokens.input += work.usage.input; tokens.output += work.usage.output; }

      const v = await deps.validate({ code, moduleName: mod.name, requirements: mod.description });
      rec.score = v.score;
      rec.passed = v.passed;
      rec.invalid = v.issues.some((i) => /Syntax error|empty or too short/i.test(i.message));
      if (iteration === 0) rec.firstPassPassed = v.passed;
      if (v.passed) break;

      ({ refinedPrompt: prompt } = await deps.generateFeedback({ issues: v.issues, originalPrompt: prompt, code, iteration }));
    }
    rec.code = code;
    modulesOut.push(rec);
    completed.set(mod.name, { code, exports: exportNames(code), filePath: deps.getFilePath(mod) });
  }

  const coverage = requirementCoverage(task, modulesOut.map((m) => m.code));

  const integrated = await deps.integrate({
    modules: mods.map((m, i) => ({ ...m, output: modulesOut[i].code })),
  });

  let sandboxResult = null;
  if (sandbox) {
    const ex = await deps.execute({ files: integrated.files });
    sandboxResult = {
      skipped: !!ex.skipped,
      success: !!ex.success,
      installSuccess: !!ex.installSuccess,
      testsTotal: ex.tests?.total ?? 0,
      testsPassed: ex.tests?.passed ?? 0,
      failures: (ex.tests?.failures || []).slice(0, 5).map((f) => ({ file: f.file, test: f.test })),
      errors: ex.errors || [],
    };
  }

  return {
    id: task.id,
    idea: task.idea,
    decomposition,
    modules: modulesOut.map(({ code: _code, ...rest }) => rest),
    coverage,
    sandbox: sandboxResult,
    latencyMs: Date.now() - started,
    tokens: tokensSeen ? tokens : null,
  };
}

module.exports = { runTask };
