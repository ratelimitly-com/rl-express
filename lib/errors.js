'use strict';

const {
  RateLimitError,
  TimeoutError,
  AuthenticationError,
  ProtocolError
} = require('ratelimitly-client');

const AVAILABILITY_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENODATA',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIME',
  'ETIMEDOUT'
]);

const AVAILABILITY_RATE_LIMIT_MESSAGES = [
  /^No servers available$/,
  /^No valid SRV targets found for /,
  /^SRV lookup failed for /
];

/**
 * Error raised when rl-express cannot construct a safe client configuration.
 */
class RateLimitConfigurationError extends Error {
  constructor(message = 'Invalid RateLimitly client configuration', options = {}) {
    super(message);
    this.name = 'RateLimitConfigurationError';
    this.code = 'RATELIMITLY_CONFIGURATION';
    this.cause = options.cause || null;
  }
}

/**
 * Error raised when a request is denied by RateLimitly admission control
 * (e.g. rate limit exceeded or latency guard triggered).
 */
class RateLimitDeniedError extends Error {
  constructor(message = 'Rate limit exceeded', options = {}) {
    super(message);
    this.name = 'RateLimitDeniedError';
    this.statusCode = options.statusCode || 429;
    this.status = this.statusCode;
    this.result = options.result || null;
    this.guardResults = options.result ? options.result.guardResults : [];
    this.resourceResults = options.result ? options.result.resourceResults : [];
    this.retryAfterSeconds = options.retryAfterSeconds || null;
  }
}

/**
 * Error raised when the RateLimitly client is unavailable (transport error,
 * DNS failure, timeout) and failOpen is configured to false.
 */
class RateLimitUnavailableError extends Error {
  constructor(message = 'RateLimitly service unavailable', options = {}) {
    super(message);
    this.name = 'RateLimitUnavailableError';
    this.statusCode = options.statusCode || 503;
    this.status = this.statusCode;
    this.cause = options.cause || null;
  }
}

/**
 * Return true only for failures that mean RateLimitly could not be reached.
 * Authentication, protocol, configuration, and application errors must never
 * be converted into an admitted request by fail-open handling.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isRateLimitlyAvailabilityError(error) {
  if (!error || typeof error !== 'object') return false;

  if (error instanceof AuthenticationError || error.name === 'AuthenticationError') return false;
  if (error instanceof ProtocolError || error.name === 'ProtocolError') return false;
  if (error instanceof RateLimitConfigurationError || error.name === 'RateLimitConfigurationError') return false;

  if (error instanceof TimeoutError || error.name === 'TimeoutError') return true;
  if (AVAILABILITY_ERROR_CODES.has(error.code)) return true;

  if (error instanceof RateLimitError || error.name === 'RateLimitError') {
    return AVAILABILITY_RATE_LIMIT_MESSAGES.some(pattern => pattern.test(error.message || ''));
  }

  return false;
}

module.exports = {
  RateLimitDeniedError,
  RateLimitUnavailableError,
  RateLimitConfigurationError,
  isRateLimitlyAvailabilityError
};
