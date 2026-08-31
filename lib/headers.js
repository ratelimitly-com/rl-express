'use strict';

const { formatSeconds } = require('./utils');

/**
 * Apply RateLimit and X-RateLimit headers to Express response.
 *
 * @param {object} res - Express Response object
 * @param {object} params - Calculation parameters
 * @param {object} params.options - Middleware options
 * @param {object} params.result - RateLimitResult from client
 * @param {number} params.limit - Configured rate limit
 * @param {number} params.windowMs - Configured window in ms
 * @param {number} params.tokensRequested - Tokens requested
 * @param {boolean} params.isAllowed - Whether request was granted
 */
function setRateLimitHeaders(res, { options, result, limit, windowMs, tokensRequested = 1, isAllowed = true }) {
  if (!res || typeof res.setHeader !== 'function') return;

  const standardHeaders = options.standardHeaders !== undefined ? options.standardHeaders : false;
  const legacyHeaders = options.legacyHeaders !== undefined ? options.legacyHeaders : false;

  if (!standardHeaders && !legacyHeaders) return;
  if (!Number.isFinite(limit) || !Number.isFinite(windowMs)) return;

  const windowSec = formatSeconds(windowMs);

  // Calculate remaining tokens
  let remaining = 0;
  if (isAllowed) {
    if (result && Array.isArray(result.resourceResults) && result.resourceResults.length > 0) {
      // If actualRate is returned by server, calculate remaining = limit - actualRate
      const primaryRes = result.resourceResults[0];
      if (typeof primaryRes.actualRate === 'number' && limit >= primaryRes.actualRate) {
        remaining = Math.max(0, limit - primaryRes.actualRate);
      } else {
        remaining = Math.max(0, limit - tokensRequested);
      }
    } else {
      remaining = Math.max(0, limit - tokensRequested);
    }
  } else {
    remaining = 0;
  }

  // Standard headers (IETF draft standard)
  if (standardHeaders) {
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(windowSec));
    res.setHeader('RateLimit-Policy', `${limit};w=${windowSec}`);

    // If request was denied, set Retry-After header
    if (!isAllowed) {
      res.setHeader('Retry-After', String(windowSec));
    }
  }

  // Legacy X-RateLimit-* headers
  if (legacyHeaders) {
    const resetTimestamp = Math.ceil(Date.now() / 1000) + windowSec;
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetTimestamp));

    if (!isAllowed && !standardHeaders) {
      res.setHeader('Retry-After', String(windowSec));
    }
  }
}

module.exports = {
  setRateLimitHeaders
};
