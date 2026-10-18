'use strict';

/**
 * Optional API-key authentication for /api.
 *
 * Off when API_KEY is unset (backward compatible; the server logs a warning at startup).
 * When set, every /api request except the health check needs the key in an
 * `Authorization: Bearer <key>` or `X-API-Key` header. Keys are never accepted in
 * URLs (they would end up in logs and browser history). Comparison is constant-time.
 */

const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createApiAuth({ apiKey = process.env.API_KEY, exemptPaths = ['/health'] } = {}) {
  if (!apiKey) return (_req, _res, next) => next();
  const expected = digest(apiKey);

  return (req, res, next) => {
    if (exemptPaths.includes(req.path)) return next();
    const header = req.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'];
    // hash both sides so comparison time does not depend on length or content
    if (typeof supplied === 'string' && supplied && crypto.timingSafeEqual(digest(supplied), expected)) return next();
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ success: false, error: 'Missing or invalid API key' });
  };
}

module.exports = { createApiAuth };
