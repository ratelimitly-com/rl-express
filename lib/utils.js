'use strict';

/**
 * Parse duration value in ms or duration string (e.g. '500ms', '1s', '1m', '1h', '1d', 'PT1M')
 * into milliseconds.
 *
 * @param {number|string} value - Number in ms or string duration
 * @param {number} defaultMs - Default value if not specified
 * @returns {number} Duration in milliseconds
 */
function parseDuration(value, defaultMs = 60000) {
  if (value === undefined || value === null) {
    return defaultMs;
  }
  if (typeof value === 'number' && !isNaN(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value !== 'string') {
    return defaultMs;
  }

  const str = value.trim().toLowerCase();
  if (!str) return defaultMs;

  // Handle ISO 8601 simple duration such as PT1M, PT10S, PT1H
  if (str.startsWith('pt')) {
    const match = str.match(/^pt(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (match) {
      const hours = parseInt(match[1] || '0', 10);
      const minutes = parseInt(match[2] || '0', 10);
      const seconds = parseInt(match[3] || '0', 10);
      const total = (hours * 3600 + minutes * 60 + seconds) * 1000;
      if (total > 0) return total;
    }
  }

  // Handle unit strings: 500ms, 10s, 1m, 1h, 1d
  const unitMatch = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|min|sec|second|seconds|minute|minutes|hour|hours|day|days)?$/);
  if (!unitMatch) {
    const num = parseFloat(str);
    return isNaN(num) ? defaultMs : Math.max(1, Math.floor(num));
  }

  const num = parseFloat(unitMatch[1]);
  const unit = unitMatch[2] || 'ms';

  switch (unit) {
    case 'ms':
      return Math.max(1, Math.floor(num));
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
      return Math.max(1, Math.floor(num * 1000));
    case 'm':
    case 'min':
    case 'minute':
    case 'minutes':
      return Math.max(1, Math.floor(num * 60 * 1000));
    case 'h':
    case 'hour':
    case 'hours':
      return Math.max(1, Math.floor(num * 3600 * 1000));
    case 'd':
    case 'day':
    case 'days':
      return Math.max(1, Math.floor(num * 86400 * 1000));
    default:
      return defaultMs;
  }
}

/**
 * Extract client IP address from Express request.
 *
 * @param {object} req - Express Request
 * @returns {string} Client IP address or fallback string
 */
function getClientIp(req) {
  if (!req) return '127.0.0.1';

  // Express req.ip (honors 'trust proxy' if configured in Express)
  if (req.ip) {
    return req.ip;
  }

  // Fallback to headers if present
  if (req.headers) {
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (xForwardedFor) {
      const firstIp = typeof xForwardedFor === 'string'
        ? xForwardedFor.split(',')[0].trim()
        : xForwardedFor[0];
      if (firstIp) return firstIp;
    }
    if (req.headers['x-real-ip']) {
      return req.headers['x-real-ip'];
    }
  }

  // Fallback to socket/connection remote address
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  if (req.connection && req.connection.remoteAddress) {
    return req.connection.remoteAddress;
  }

  return '127.0.0.1';
}

/**
 * Default key generator for Express rate limiting.
 * Returns the client IP address.
 *
 * @param {object} req - Express Request
 * @param {object} res - Express Response
 * @returns {string} Key
 */
function defaultKeyGenerator(req, res) {
  return getClientIp(req);
}

/**
 * Default metrics label generator for Express rate limiting.
 * Generates an informative label based on HTTP method and route path.
 *
 * @param {object} req - Express Request
 * @param {object} res - Express Response
 * @returns {string} Metrics label
 */
function defaultMetricsLabel(req, res) {
  if (!req) return 'express.unknown';
  const method = (req.method || 'GET').toLowerCase();
  const routePath = (req.baseUrl || '') + (req.route?.path || req.path || '/');
  // Clean up special characters for metrics compatibility
  const sanitizedPath = routePath.replace(/[^a-zA-Z0-9_/.-]/g, '_');
  return `express.${method}.${sanitizedPath}`;
}

/**
 * Format milliseconds into seconds for Retry-After and Reset headers.
 *
 * @param {number} ms - Milliseconds
 * @returns {number} Seconds rounded up (minimum 1)
 */
function formatSeconds(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Check if a value is a Promise.
 *
 * @param {any} val - Value to check
 * @returns {boolean} True if val is a Promise
 */
function isPromise(val) {
  return Boolean(val && typeof val.then === 'function');
}

module.exports = {
  parseDuration,
  getClientIp,
  defaultKeyGenerator,
  defaultMetricsLabel,
  formatSeconds,
  isPromise
};
