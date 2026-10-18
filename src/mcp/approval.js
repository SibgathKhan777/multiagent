'use strict';

/**
 * Human/policy approval for sensitive MCP tools.
 *
 * The MCP *client* process (trusted host) owns a random secret that it also gives
 * to the server it spawns. A sensitive call only executes if it carries a token the
 * host minted after its approver said yes: HMAC(secret, tool + canonical args + timestamp).
 * A model that merely chooses a tool and arguments cannot produce one, and a token
 * cannot be replayed for different arguments or after the TTL.
 */

const crypto = require('crypto');

const TTL_MS = 60_000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mac(secret, tool, args, ts) {
  const { approval: _ignored, ...rest } = args || {};
  return crypto.createHmac('sha256', secret).update(`${tool}\n${canonical(rest)}\n${ts}`).digest('hex');
}

function signApproval(secret, tool, args, now = Date.now()) {
  return `${now}.${mac(secret, tool, args, now)}`;
}

/** @returns {{ ok: boolean, reason?: string }} */
function verifyApproval(secret, tool, args, now = Date.now()) {
  const token = args && args.approval;
  if (!secret) return { ok: false, reason: 'approval secret not configured' };
  if (typeof token !== 'string') return { ok: false, reason: 'approval required' };
  const [tsRaw, given] = token.split('.');
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !given) return { ok: false, reason: 'malformed approval token' };
  if (now - ts > TTL_MS || ts - now > 5_000) return { ok: false, reason: 'approval expired' };
  const expected = mac(secret, tool, args, ts);
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'approval does not match this call' };
  return { ok: true };
}

module.exports = { signApproval, verifyApproval, canonical, TTL_MS };
