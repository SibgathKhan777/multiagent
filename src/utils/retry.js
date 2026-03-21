const logger = require('./logger').forAgent('retry');

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn        - Async function to retry
 * @param {Object}   opts
 * @param {number}   opts.maxAttempts - Max attempts (default: 3)
 * @param {number}   opts.baseDelay  - Base delay in ms (default: 1000)
 * @param {string}   opts.label      - Label for logs
 * @returns {Promise<*>}
 */
async function retry(fn, { maxAttempts = 3, baseDelay = 1000, label = 'operation' } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`, {
          error: err.message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  logger.error(`${label} failed after ${maxAttempts} attempts`, { error: lastError.message });
  throw lastError;
}

module.exports = { retry };
