const logger = require('../utils/logger').forAgent('Validator');
const { runtimeCheck: dockerRuntimeCheck } = require('./runtimeCheck');

/**
 * Validator Agent
 *
 * Input:  { code: string, moduleName: string, requirements: string }
 * Output: { score: number (0-100), issues: Issue[], passed: boolean, runtime: Object }
 *
 * TWO-PHASE VALIDATION:
 * Phase 1: Static analysis  — checks patterns, structure, security
 * Phase 2: Runtime check   — loads the module and test-calls its exports INSIDE a Docker
 *                             container (never on the host; skipped if Docker is unavailable)
 */

/**
 * Validate code quality for a module.
 */
async function validate({ code, moduleName, requirements = '' }, { runtimeCheck = dockerRuntimeCheck } = {}) {
  logger.info(`Validating module: "${moduleName}" (${code.length} chars)`);

  const issues = [];
  let score = 100;

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: STATIC ANALYSIS
  // ═══════════════════════════════════════════════════════════════

  // ─── 1. Basic existence check ────────────────────────────────────
  if (!code || code.trim().length < 50) {
    issues.push({ type: 'error', message: 'Code is empty or too short', severity: 10 });
    return { score: 0, issues, passed: false, runtime: { executed: false, reason: 'no code' } };
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
  const runtimeResult = await runtimeCheck({ code, moduleName });

  if (!runtimeResult.executed) {
    // Not run (no Docker / disabled): neither a bonus nor a penalty, but visible
    issues.push({ type: 'suggestion', message: `Runtime check skipped: ${runtimeResult.reason}`, severity: 1 });
  }

  if (runtimeResult.executed && runtimeResult.loadError) {
    issues.push({ type: 'error', message: `Runtime crash: ${runtimeResult.loadError}`, severity: 9 });
    score -= 15;
  }

  if (runtimeResult.executed && runtimeResult.loaded && runtimeResult.exportCount === 0) {
    issues.push({ type: 'warning', message: 'Module loaded but exports nothing usable', severity: 7 });
    score -= 10;
  }

  if (runtimeResult.executed && runtimeResult.loaded && runtimeResult.exportCount > 0) {
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

module.exports = { validate };
