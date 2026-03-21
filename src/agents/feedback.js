const logger = require('../utils/logger').forAgent('Feedback');

/**
 * Feedback Agent
 *
 * Input:  { issues: Issue[], originalPrompt: string, code: string, iteration: number }
 * Output: { refinedPrompt: string, suggestions: string[] }
 *
 * Converts validation issues into specific prompt improvements.
 * Escalates constraints on each iteration.
 */

// Map issue types to prompt instructions
const ISSUE_FIX_MAP = {
  'Syntax error':               'Fix all syntax errors. Ensure the code is valid JavaScript that can be parsed without errors.',
  'Missing module.exports':     'CRITICAL: You MUST include module.exports at the end of the file to export all public functions.',
  'No error handling':          'Add comprehensive error handling with try-catch blocks around all async operations and throw meaningful errors for invalid inputs.',
  'Limited input validation':   'Add input validation: check for null/undefined, validate types, check string lengths, and validate array contents before processing.',
  'Security risk: eval()':      'NEVER use eval(). Replace any eval() calls with safe alternatives.',
  'hardcoded secret':           'Do NOT hardcode passwords, API keys, or secrets. Use process.env for all sensitive values.',
  'No comments':                'Add JSDoc comments for all exported functions and inline comments explaining complex logic.',
  'No functions':               'Structure the code into well-named functions. Each function should do one thing.',
  'async/await':                'Use async/await for all asynchronous operations instead of .then() callback chains.',
  'Low requirement coverage':   'Make sure the implementation fully covers all requirements described in the task.',
};

/**
 * Generate refined prompt based on validation issues.
 */
async function generateFeedback({ issues, originalPrompt, code, iteration }) {
  logger.info(`Generating feedback — iteration: ${iteration}, issues: ${issues.length}`);

  const suggestions = [];
  const fixInstructions = [];

  // Convert each issue into a specific fix instruction
  for (const issue of issues) {
    for (const [pattern, instruction] of Object.entries(ISSUE_FIX_MAP)) {
      if (issue.message.toLowerCase().includes(pattern.toLowerCase())) {
        if (!fixInstructions.includes(instruction)) {
          fixInstructions.push(instruction);
          suggestions.push(`[${issue.type.toUpperCase()}] ${issue.message} → ${instruction}`);
        }
        break;
      }
    }

    // If no pattern matched, create a generic instruction
    if (!suggestions.some((s) => s.includes(issue.message))) {
      const genericFix = `Fix: ${issue.message}`;
      fixInstructions.push(genericFix);
      suggestions.push(`[${issue.type.toUpperCase()}] ${issue.message}`);
    }
  }

  // Escalation: add stricter constraints on later iterations
  const escalation = [];
  if (iteration >= 2) {
    escalation.push('THIS IS YOUR FINAL ATTEMPT. The code MUST pass all quality checks.');
    escalation.push('Double-check every function has error handling, input validation, and proper exports.');
  }
  if (iteration >= 1) {
    escalation.push('The previous version had issues. Review EACH requirement carefully before writing code.');
  }

  // Build refined prompt
  const refinedPrompt = `
${originalPrompt}

---

## MANDATORY FIXES (Iteration ${iteration + 1})

The previous code had ${issues.length} issue(s) that MUST be fixed:

${fixInstructions.map((fix, i) => `${i + 1}. ${fix}`).join('\n')}

${escalation.length > 0 ? '## IMPORTANT\n' + escalation.join('\n') : ''}

## Previous Code Reference
Your previous output had these problems. Do NOT repeat them.
Generate a COMPLETE, corrected version from scratch.
`.trim();

  logger.info(`Feedback generated — ${suggestions.length} suggestions, prompt length: ${refinedPrompt.length}`);

  return { refinedPrompt, suggestions };
}

module.exports = { generateFeedback };
