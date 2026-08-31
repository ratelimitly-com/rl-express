'use strict';

const { ProtocolError } = require('ratelimitly-client');
const { isPromise } = require('./utils');
const {
  RateLimitDeniedError,
  RateLimitUnavailableError,
  RateLimitConfigurationError,
  isRateLimitlyAvailabilityError
} = require('./errors');
const { resolveClient } = require('./client_factory');
const { normalizeLatencyGuard } = require('./latency_tracker');

function checkRateLimitAsync(client, resources, guards, metricsLabel) {
  return new Promise((resolve) => {
    client.checkRateLimit(resources, guards, metricsLabel, (err, result) => {
      resolve({ err, result });
    });
  });
}

/**
 * Standalone Express middleware for latency-based load shedding.
 * Checks whether tracked downstream services are operating below latency thresholds.
 *
 * @param {object} options - Latency guard options
 * @returns {Function} Express middleware function
 */
function latencyGuardMiddleware(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RateLimitConfigurationError('Latency guard options must be an object');
  }
  const hasGuard = options.guard !== undefined;
  const hasGuards = options.guards !== undefined;
  if (hasGuard && hasGuards) {
    throw new RateLimitConfigurationError('Do not configure both guard and guards');
  }
  if (hasGuards && !Array.isArray(options.guards) && typeof options.guards !== 'function') {
    throw new RateLimitConfigurationError('guards must be an array or resolver function');
  }
  const staticGuards = hasGuard
    ? [normalizeLatencyGuard(options.guard)]
    : (Array.isArray(options.guards)
        ? options.guards.map((value, index) => normalizeLatencyGuard(value, `guards[${index}]`))
        : null);
  const client = resolveClient(options);
  const failOpen = options.failOpen !== undefined ? options.failOpen : true;
  const statusCode = options.statusCode || 429;
  const message = options.message || {
    error: 'Too Many Requests',
    message: 'Service is experiencing degraded performance; request load shed by latency guard.'
  };

  return async function latencyGuard(req, res, next) {
    try {
      if (typeof options.skip === 'function') {
        const shouldSkip = options.skip(req, res);
        if (isPromise(shouldSkip) ? await shouldSkip : shouldSkip) {
          return next();
        }
      }

      let guards = staticGuards || [];
      if (typeof options.guards === 'function') {
        const evaluated = options.guards(req, res);
        guards = isPromise(evaluated) ? await evaluated : evaluated;
      }

      if (!Array.isArray(guards)) {
        throw new RateLimitConfigurationError('guards resolver must return an array');
      }
      if (!staticGuards) {
        guards = guards.map((value, index) => normalizeLatencyGuard(value, `guards[${index}]`));
      }

      if (guards.length === 0) {
        return next();
      }

      const metricsLabel = typeof options.metricsLabel === 'function'
        ? options.metricsLabel(req, res)
        : (options.metricsLabel || null);

      const { err, result } = await checkRateLimitAsync(client, [], guards, metricsLabel);

      if (err) {
        if (!isRateLimitlyAvailabilityError(err)) {
          return next(err);
        }

        if (failOpen) {
          if (typeof options.onError === 'function') {
            options.onError(err, req, res);
          } else if (process.env.DEBUG || process.env.NODE_ENV !== 'production') {
            console.warn(`[rl-express] Latency guard check failed (${err.name || 'Error'}: ${err.message}) - failing open`);
          }
          return next();
        }

        const unavailError = new RateLimitUnavailableError(
          `RateLimitly latency guard check failed: ${err.message}`,
          { cause: err, statusCode: 503 }
        );

        if (typeof options.errorHandler === 'function') {
          return options.errorHandler(unavailError, req, res, next, options);
        }
        return res.status(503).json({ error: 'Service Unavailable', message: unavailError.message });
      }

      if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') {
        return next(new ProtocolError('RateLimitly client returned no valid admission decision'));
      }

      if (result.success) {
        req.rateLimitlyGuards = result.guardResults;
        return next();
      }

      // Guard triggered
      const failedGuards = result && result.guardResults ? result.guardResults.filter(g => !g.passed) : [];
      const deniedError = new RateLimitDeniedError('Latency threshold exceeded', {
        statusCode,
        result
      });

      if (typeof options.onGuardTriggered === 'function') {
        options.onGuardTriggered(req, res, options, failedGuards);
      }

      if (typeof options.handler === 'function') {
        return options.handler(req, res, next, options, result);
      }

      if (typeof message === 'object') {
        return res.status(statusCode).json(message);
      }
      return res.status(statusCode).send(message);
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  latencyGuardMiddleware
};
