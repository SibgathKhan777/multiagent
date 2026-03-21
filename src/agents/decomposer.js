const { v4: uuid } = require('uuid');
const logger = require('../utils/logger').forAgent('Decomposer');

/**
 * Task Decomposer Agent
 *
 * Input:  { idea: string }
 * Output: Module[] — array of { name, description, type, dependencies[], priority }
 *
 * Uses keyword analysis and pattern matching to break down a software idea
 * into 4-8 composable modules.
 */

// Module templates keyed by detected domain keywords
const MODULE_TEMPLATES = {
  // --- Common backend patterns ---
  authentication: {
    name: 'Authentication Module',
    description: 'User registration, login, JWT token generation and verification, password hashing, and middleware for protected routes.',
    type: 'authentication',
    dependencies: ['Database Module'],
    priority: 2,
  },
  database: {
    name: 'Database Module',
    description: 'MongoDB connection setup, Mongoose schema definitions, model exports, and database utility functions (CRUD helpers).',
    type: 'database',
    dependencies: [],
    priority: 1,
  },
  api: {
    name: 'API Routes Module',
    description: 'Express router definitions for all REST API endpoints, request validation, response formatting, and error handling middleware.',
    type: 'api',
    dependencies: ['Database Module', 'Authentication Module'],
    priority: 3,
  },
  middleware: {
    name: 'Middleware Module',
    description: 'Express middleware functions: error handler, request logger, rate limiter, CORS configuration, and input sanitization.',
    type: 'middleware',
    dependencies: [],
    priority: 1,
  },
  config: {
    name: 'Configuration Module',
    description: 'Application configuration management: environment variables, config validation, and centralized settings export.',
    type: 'config',
    dependencies: [],
    priority: 0,
  },
  // --- Domain-specific patterns ---
  'real-time': {
    name: 'Real-time Module',
    description: 'WebSocket or Socket.IO integration for real-time communication, event broadcasting, and connection management.',
    type: 'utilities',
    dependencies: ['Authentication Module'],
    priority: 4,
  },
  payment: {
    name: 'Payment Module',
    description: 'Payment processing integration with Stripe/PayPal, order payment flow, refund handling, and webhook processing.',
    type: 'business-logic',
    dependencies: ['Database Module', 'API Routes Module'],
    priority: 4,
  },
  notification: {
    name: 'Notification Module',
    description: 'Email and push notification service, notification templates, delivery queue, and user preference management.',
    type: 'utilities',
    dependencies: ['Database Module'],
    priority: 5,
  },
  search: {
    name: 'Search Module',
    description: 'Full-text search implementation, filtering, sorting, pagination, and search index management.',
    type: 'utilities',
    dependencies: ['Database Module'],
    priority: 4,
  },
  upload: {
    name: 'File Upload Module',
    description: 'File upload handling with Multer, cloud storage integration (S3), image processing, and file validation.',
    type: 'utilities',
    dependencies: ['Configuration Module'],
    priority: 3,
  },
  cache: {
    name: 'Caching Module',
    description: 'Redis-based caching layer, cache invalidation strategies, response caching middleware, and cache utility functions.',
    type: 'utilities',
    dependencies: ['Configuration Module'],
    priority: 2,
  },
};

// Domain-specific keyword → module mapping
const DOMAIN_KEYWORDS = {
  'food delivery':  ['database', 'api', 'authentication', 'middleware', 'config', 'real-time', 'payment', 'notification'],
  'e-commerce':     ['database', 'api', 'authentication', 'middleware', 'config', 'payment', 'search', 'upload'],
  'social media':   ['database', 'api', 'authentication', 'middleware', 'config', 'real-time', 'upload', 'notification', 'search'],
  'chat':           ['database', 'api', 'authentication', 'middleware', 'config', 'real-time', 'notification'],
  'blog':           ['database', 'api', 'authentication', 'middleware', 'config', 'search', 'upload'],
  'task management':['database', 'api', 'authentication', 'middleware', 'config', 'notification', 'real-time'],
  'booking':        ['database', 'api', 'authentication', 'middleware', 'config', 'payment', 'notification'],
};

// Fallback — always include these
const CORE_MODULES = ['config', 'database', 'api', 'middleware', 'authentication'];

/**
 * Decompose an idea into structured modules.
 */
async function decompose({ idea }) {
  logger.info(`Decomposing idea: "${idea}"`);

  const ideaLower = idea.toLowerCase();

  // 1. Detect domain
  let detectedModuleKeys = [...CORE_MODULES];
  for (const [domain, keys] of Object.entries(DOMAIN_KEYWORDS)) {
    if (ideaLower.includes(domain)) {
      logger.info(`Domain detected: "${domain}"`);
      detectedModuleKeys = [...new Set([...detectedModuleKeys, ...keys])];
      break;
    }
  }

  // 2. Scan for additional keyword hits
  const extraKeywords = {
    'payment':      'payment',
    'pay':          'payment',
    'order':        'payment',
    'real-time':    'real-time',
    'realtime':     'real-time',
    'live':         'real-time',
    'track':        'real-time',
    'socket':       'real-time',
    'notification': 'notification',
    'notify':       'notification',
    'alert':        'notification',
    'email':        'notification',
    'search':       'search',
    'filter':       'search',
    'upload':       'upload',
    'image':        'upload',
    'file':         'upload',
    'cache':        'cache',
    'fast':         'cache',
    'scalable':     'cache',
  };

  for (const [keyword, moduleKey] of Object.entries(extraKeywords)) {
    if (ideaLower.includes(keyword) && !detectedModuleKeys.includes(moduleKey)) {
      detectedModuleKeys.push(moduleKey);
    }
  }

  // 3. Build module list — inject the idea into EVERY module description
  //    so each project gets unique, idea-specific code from the LLM
  const modules = detectedModuleKeys
    .filter((key) => MODULE_TEMPLATES[key])
    .map((key) => {
      const template = MODULE_TEMPLATES[key];
      return {
        moduleId: uuid(),
        ...template,
        description: `${template.description} This module is specifically for: "${idea}".`,
      };
    });

  // 4. Add a business logic module specific to the idea
  const businessModule = {
    moduleId: uuid(),
    name: 'Core Business Logic',
    description: `Core business logic for: ${idea}. Includes domain-specific services, data transformations, business rules, and orchestration of core workflows unique to this application.`,
    type: 'business-logic',
    dependencies: ['Database Module', 'API Routes Module'],
    priority: 4,
  };
  modules.push(businessModule);

  // Sort by priority
  modules.sort((a, b) => a.priority - b.priority);

  logger.info(`Decomposition complete: ${modules.length} modules generated`, {
    modules: modules.map((m) => m.name),
  });

  return modules;
}

module.exports = { decompose };
