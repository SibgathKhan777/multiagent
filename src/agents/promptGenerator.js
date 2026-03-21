const modelsConfig = require('../../config/models');
const logger = require('../utils/logger').forAgent('PromptGenerator');

/**
 * Prompt Generator Agent
 *
 * Input:  { module: { name, description, type, dependencies[] }, context: string }
 * Output: { prompt: string, model: string }
 *
 * Builds an optimized, structured prompt for each module and selects the
 * best model based on module type.
 */

// Prompt optimization strategies applied to every prompt
const OPTIMIZATIONS = [
  'Think step-by-step before writing any code.',
  'Include comprehensive error handling with try-catch blocks.',
  'Add JSDoc comments for all exported functions.',
  'Use async/await for all asynchronous operations.',
  'Follow RESTful conventions and proper HTTP status codes.',
  'Never hardcode secrets; use environment variables.',
  'Export all public interfaces at the end of the file.',
];

// Type-specific extra instructions
const TYPE_INSTRUCTIONS = {
  database: [
    'Use Mongoose for MongoDB. Define schemas with proper validation.',
    'Include indexes on frequently queried fields.',
    'Add pre-save hooks where appropriate.',
  ],
  api: [
    'Use Express Router. Group related endpoints.',
    'Validate request body/params using inline checks.',
    'Return consistent JSON response shape: { success, data, error }.',
  ],
  authentication: [
    'Use bcrypt for password hashing (10 salt rounds).',
    'Use jsonwebtoken for JWT tokens.',
    'Create middleware that verifies JWT and attaches user to req.',
  ],
  middleware: [
    'Export each middleware as a named function.',
    'Include a centralized error handler that logs and returns JSON.',
  ],
  'business-logic': [
    'Implement as a service layer with pure functions where possible.',
    'Keep business rules separate from transport (HTTP) logic.',
  ],
  utilities: [
    'Make functions generic and reusable.',
    'Include sensible defaults for all parameters.',
  ],
  config: [
    'Validate all required environment variables on startup.',
    'Export a frozen config object.',
  ],
};

/**
 * Select the best model tier for a given module type.
 */
function selectModel(moduleType) {
  return modelsConfig.assignments[moduleType] || modelsConfig.assignments.default;
}

/**
 * Get a display name for the selected model tier.
 */
function getModelDisplayName(tier) {
  const provider = modelsConfig.provider || 'simulated';
  const providerModels = modelsConfig[provider]?.models;
  if (providerModels && providerModels[tier]) {
    return `${provider}/${providerModels[tier]}`;
  }
  return `${provider}/${tier}`;
}

/**
 * Generate an optimized prompt for a module.
 */
async function generatePrompt({ module, context = '', siblingModules = [] }) {
  logger.info(`Generating prompt for module: "${module.name}" (type: ${module.type})`);

  const tier = selectModel(module.type);
  const displayName = getModelDisplayName(tier);

  const typeInstructions = TYPE_INSTRUCTIONS[module.type] || TYPE_INSTRUCTIONS.utilities;

  // Build sibling imports section with exact file paths
  let siblingSection = '';
  if (siblingModules.length > 0) {
    const relevantSiblings = siblingModules.filter(s => module.dependencies.includes(s.name));
    if (relevantSiblings.length > 0) {
      // Calculate the current module's file path
      const currentPath = getModuleFilePath(module.type, module.name);
      const currentDir = currentPath.substring(0, currentPath.lastIndexOf('/'));

      const importLines = relevantSiblings.map(s => {
        const siblingPath = s.filePath;
        const relativePath = calculateRelativePath(currentDir, siblingPath);
        const exportsStr = s.exports.length > 0 ? s.exports.join(', ') : 'default export';
        return `- **${s.name}** → \`require('${relativePath}')\` exports: { ${exportsStr} }`;
      }).join('\n');

      siblingSection = `
## Available Modules (EXACT require paths)
${importLines}

CRITICAL RULES:
- ONLY use the require() paths listed above for cross-module imports
- NEVER require('./database'), require('./auth'), or any other invented path
- Use the EXACT export names shown above — do not guess function names
- For npm packages, only use require() with packages that actually exist (e.g., express, mongoose, bcrypt, jsonwebtoken, dotenv)
`;
    }
  }

  const prompt = `
## Role
You are an expert Node.js backend engineer. You write clean, production-ready code.

## PROJECT
You are building: **${context || 'a backend system'}**
All code you write MUST be specific and tailored to this project. Do NOT write generic boilerplate.

## Task
Generate the complete implementation for the **${module.name}**.
This file will be saved at: \`${getModuleFilePath(module.type, module.name)}\`

## Description
${module.description}
${siblingSection}
## Dependencies
${module.dependencies.length > 0 ? module.dependencies.map((d) => `- ${d}`).join('\n') : 'None — this is a standalone module.'}

## Technical Requirements
${typeInstructions.map((i) => `- ${i}`).join('\n')}

## STRICT RULES
- NEVER use require() with a path to a file that does not exist
- ONLY require npm packages (e.g., 'express', 'mongoose') or the exact sibling paths listed above
- Do NOT invent require('./database'), require('./auth'), etc.
- Your module.exports keys MUST match the actual function/variable names you define
- All require()'d npm packages must be real, published npm packages
- Use 'bcrypt' not 'bcryptjs', use 'jsonwebtoken' not 'jwt'

## Code Quality Standards
${OPTIMIZATIONS.map((o) => `- ${o}`).join('\n')}

## Output Format
Return ONLY a single JavaScript file with:
1. npm package imports at the top (express, mongoose, etc.)
2. Cross-module imports using ONLY the exact paths from Available Modules above
3. Implementation specific to "${context || 'this project'}"
4. module.exports = { ...allExportedFunctions } at the bottom

Do NOT include markdown fences, explanations outside the code, or multiple files.
`.trim();

  logger.info(`Prompt generated (${prompt.length} chars), assigned model: ${displayName} (tier: ${tier})`);

  return { prompt, model: tier };
}

/**
 * Calculate the file path for a module type/name.
 */
function getModuleFilePath(type, name) {
  const nameSlug = name
    .toLowerCase()
    .replace(/\s+module$/i, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  const pathMap = {
    config:          `config/${nameSlug}.js`,
    database:        `src/models/index.js`,
    authentication:  `src/auth/auth.js`,
    api:             `src/routes/api.js`,
    middleware:       `src/middleware/index.js`,
    'business-logic': `src/services/${nameSlug}.js`,
    utilities:        `src/utils/${nameSlug}.js`,
  };

  return pathMap[type] || `src/${nameSlug}.js`;
}

/**
 * Calculate a relative path from a directory to a file.
 */
function calculateRelativePath(fromDir, toFile) {
  const fromParts = fromDir.split('/').filter(Boolean);
  const toParts = toFile.split('/').filter(Boolean);

  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }

  const ups = fromParts.length - common;
  const remaining = toParts.slice(common);

  const prefix = ups > 0 ? '../'.repeat(ups) : './';
  let result = prefix + remaining.join('/');
  result = result.replace(/\.js$/, '');

  return result;
}

module.exports = { generatePrompt };

