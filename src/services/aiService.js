'use strict';

const axios = require('axios');
const { retry } = require('../utils/retry');
const logger = require('../utils/logger').forAgent('aiService');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const _client = axios.create({
  baseURL: AI_SERVICE_URL,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

const NODE_BASE_URL = process.env.NODE_BASE_URL || 'http://localhost:3000';

/**
 * POST to the Python AI service with retry + exponential backoff.
 */
async function _post(endpoint, body) {
  return retry(
    async () => {
      const res = await _client.post(endpoint, body);
      return res.data;
    },
    { maxAttempts: 3, baseDelay: 1000, label: `aiService${endpoint}` },
  );
}

/**
 * Run the CrewAI sequential pipeline via POST /crew/run.
 * Returns: { architecture, code, review, tests, final_project }
 */
async function callCrew(idea) {
  logger.info(`callCrew: posting idea (${idea.length} chars) to ${AI_SERVICE_URL}/crew/run`);
  const result = await _post('/crew/run', { idea });
  logger.info('callCrew: response received');
  return result;
}

/**
 * Run the LangGraph workflow via POST /graph/run.
 * Passes task_id and callback_url so Python nodes can POST real-time progress.
 * Returns: { architecture, code, review_score, review_feedback, tests, final_project }
 *
 * @param {string} idea
 * @param {string} taskId   - pipeline taskId (used as socket.io room)
 * @param {string} callbackUrl - URL Python will POST progress to (defaults to this server)
 */
async function callGraph(idea, taskId = '', callbackUrl = '') {
  const resolvedCallback = callbackUrl || `${NODE_BASE_URL}/api/progress`;
  logger.info(`callGraph: posting to ${AI_SERVICE_URL}/graph/run`, { taskId, callbackUrl: resolvedCallback });
  const result = await _post('/graph/run', {
    idea,
    task_id: taskId,
    callback_url: resolvedCallback,
  });
  logger.info(`callGraph: response received (review_score=${result.review_score})`, { taskId });
  return result;
}

module.exports = { callCrew, callGraph };
