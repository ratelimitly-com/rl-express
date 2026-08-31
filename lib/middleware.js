'use strict';

const {
  ResourceRequest,
  ProtocolError
} = require('ratelimitly-client');

const {
  parseDuration,
  defaultMetricsLabel,
  isPromise
} = require('./utils');
const { setRateLimitHeaders } = require('./headers');
const { resolveClient } = require('./client_factory');
const { normalizeLatencyGuard } = require('./latency_tracker');
const {
  normalizeReporterConfiguration,
  attachLatencyReporter
} = require('./latency_reporter');
const {
  RateLimitUnavailableError,
  RateLimitConfigurationError,
  isRateLimitlyAvailabilityError
} = require('./errors');

const CONVENIENCE_RESOURCE_OPTIONS = [
  'windowMs',
  'window',
  'limit',
  'max',
  'rate',
  'tokensRequested',
  'tokens',
  'bucketId',
  'bucket',
  'context',
  'prefix',
  'resourceKeyPrefix',
  'keyGenerator'
];

const REMOVED_POST_RESPONSE_SKIP_OPTIONS = [
  'skipSuccessfulRequests',
  'skipFailedRequests',
  'requestWasSuccessful'
];

function configured(options, name) {
  return options[name] !== undefined;
}

function firstConfigured(options, names) {
  for (const name of names) {
    if (configured(options, name)) return options[name];
  }
  return undefined;
}

function rejectPostResponseSkipOptions(options) {
  for (const name of REMOVED_POST_RESPONSE_SKIP_OPTIONS) {
    if (configured(options, name)) {
      throw new RateLimitConfigurationError(
        `${name} is not supported because a response outcome cannot undo RateLimitly admission; use skip before admission`
      );
    }
  }
}

function validatePositiveUint32(value, name) {
  if (!Number.isInteger(value) || value <= 0 || value > 0xFFFF_FFFF) {
    throw new RateLimitConfigurationError(`${name} must be a positive uint32 integer`);
  }
  return value;
}

function resolveResourceConfiguration(options) {
  const hasResources = configured(options, 'resources');
  const hasResource = configured(options, 'resource');
  const hasConvenience = CONVENIENCE_RESOURCE_OPTIONS.some(name => configured(options, name));

  if (hasResources && hasResource) {
    throw new RateLimitConfigurationError('Do not configure both resource and resources');
  }
  if (hasResources && !Array.isArray(options.resources) && typeof options.resources !== 'function') {
    throw new RateLimitConfigurationError('resources must be an array or resolver function');
  }
  if (hasResource && (!options.resource || typeof options.resource !== 'object')) {
    throw new RateLimitConfigurationError('resource must be a ResourceRequest object');
  }
  if ((hasResources || hasResource) && hasConvenience) {
    throw new RateLimitConfigurationError(
      'Do not mix resource/resources with convenience resource options'
    );
  }

  if (!hasConvenience) {
    return { hasResources, hasResource, convenience: null };
  }

  const windowValue = firstConfigured(options, ['windowMs', 'window']);
  if (windowValue === undefined) {
    throw new RateLimitConfigurationError('Convenience resource configuration requires window or windowMs');
  }
  const parsedWindowMs = parseDuration(windowValue, Number.NaN);
  if (!Number.isFinite(parsedWindowMs)) {
    throw new RateLimitConfigurationError('window/windowMs must be a valid positive duration');
  }
  const windowMs = validatePositiveUint32(parsedWindowMs, 'window/windowMs');

  const limitValue = firstConfigured(options, ['limit', 'max', 'rate']);
  if (limitValue === undefined) {
    throw new RateLimitConfigurationError('Convenience resource configuration requires limit, max, or rate');
  }
  const limit = validatePositiveUint32(limitValue, 'limit/max/rate');

  const keyGenerator = options.keyGenerator;
  const bucket = firstConfigured(options, ['bucketId', 'bucket', 'context']);
  if (bucket !== undefined && keyGenerator !== undefined) {
    throw new RateLimitConfigurationError('Configure bucketId or keyGenerator, not both');
  }
  if (bucket === undefined && typeof keyGenerator !== 'function') {
    throw new RateLimitConfigurationError(
      'Convenience resource configuration requires bucketId or keyGenerator'
    );
  }
  if (bucket !== undefined && typeof bucket !== 'string' && typeof bucket !== 'function') {
    throw new RateLimitConfigurationError('bucketId/bucket/context must be a string or resolver function');
  }
  if (keyGenerator !== undefined && typeof keyGenerator !== 'function') {
    throw new RateLimitConfigurationError('keyGenerator must be a function');
  }

  const tokensValue = firstConfigured(options, ['tokensRequested', 'tokens']);
  const tokensRequested = validatePositiveUint32(
    tokensValue === undefined ? 1 : tokensValue,
    'tokensRequested/tokens'
  );
  const prefix = firstConfigured(options, ['prefix', 'resourceKeyPrefix']);
  if (prefix !== undefined && typeof prefix !== 'string') {
    throw new RateLimitConfigurationError('prefix/resourceKeyPrefix must be a string');
  }

  return {
    hasResources,
    hasResource,
    convenience: {
      bucket,
      keyGenerator,
      prefix: prefix === undefined ? 'rl:' : prefix,
      windowMs,
      limit,
      tokensRequested
    }
  };
}

function checkRateLimitAsync(client, resources, guards, metricsLabel) {
  return new Promise((resolve) => {
    client.checkRateLimit(resources, guards, metricsLabel, (err, result) => {
      resolve({ err, result });
    });
  });
}

/**
 * Creates an Express rate-limiting and admission-control middleware using RateLimitly.
 *
 * @param {object} [options={}] - Middleware configuration options
 * @returns {Function} Express middleware function: (req, res, next) => void
 */
function rateLimitly(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RateLimitConfigurationError('Middleware options must be an object');
  }
  rejectPostResponseSkipOptions(options);
  const resourceConfiguration = resolveResourceConfiguration(options);
  const hasGuards = configured(options, 'guards');
  const hasGuard = configured(options, 'guard');
  if (hasGuards && hasGuard) {
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
  if (options.onLatencyReportError !== undefined && typeof options.onLatencyReportError !== 'function') {
    throw new RateLimitConfigurationError('onLatencyReportError must be a function');
  }
  const reporterConfiguration = options.reportLatency === undefined
    ? null
    : normalizeReporterConfiguration(options.reportLatency);

  // Client resolution follows local validation so invalid middleware options
  // cannot create or cache a client.
  const client = resolveClient(options);
  if (reporterConfiguration && typeof client.reportLatency !== 'function') {
    throw new RateLimitConfigurationError(
      'Configured client must implement reportLatency when reportLatency is enabled'
    );
  }
  const convenience = resourceConfiguration.convenience;
  const windowMs = convenience ? convenience.windowMs : undefined;
  const limit = convenience ? convenience.limit : undefined;
  const tokensRequested = convenience ? convenience.tokensRequested : undefined;

  // Failure and error policy
  const failOpen = options.failOpen !== undefined
    ? options.failOpen
    : (options.passOnRateLimitError !== undefined ? options.passOnRateLimitError : true);

  // Response configuration on limit exceeded
  const statusCode = options.statusCode || 429;
  const message = options.message !== undefined
    ? options.message
    : 'Too many requests, please try again later.';

  const requestPropertyName = options.requestPropertyName || 'rateLimitly';

  // Default handler on rate limit exceeded
  const defaultHandler = (req, res, next, opts, result) => {
    if (res.headersSent) return;
    if (typeof message === 'object') {
      res.status(statusCode).json(message);
    } else {
      res.status(statusCode).send(message);
    }
  };

  const handler = typeof options.handler === 'function' ? options.handler : defaultHandler;

  // Middleware function
  return async function rateLimitlyMiddleware(req, res, next) {
    try {
      // Check skip condition
      if (typeof options.skip === 'function') {
        const shouldSkip = options.skip(req, res);
        if (isPromise(shouldSkip) ? await shouldSkip : shouldSkip) {
          return next();
        }
      }

      // Resolve resources
      let resources = [];
      if (resourceConfiguration.hasResources && typeof options.resources === 'function') {
        const evalRes = options.resources(req, res);
        resources = isPromise(evalRes) ? await evalRes : evalRes;
      } else if (resourceConfiguration.hasResources) {
        resources = options.resources;
      } else if (resourceConfiguration.hasResource) {
        resources = [options.resource];
      } else if (convenience) {
        // Build one explicitly configured convenience resource.
        let bucketId;
        if (typeof convenience.bucket === 'function') {
          const evalBucket = convenience.bucket(req, res);
          bucketId = isPromise(evalBucket) ? await evalBucket : evalBucket;
        } else if (convenience.bucket !== undefined) {
          bucketId = convenience.bucket;
        } else {
          const generatedKey = convenience.keyGenerator(req, res);
          bucketId = `${convenience.prefix}${generatedKey}`;
        }

        if (typeof bucketId !== 'string' || bucketId.length === 0) {
          throw new RateLimitConfigurationError('Resource identity resolver must return a non-empty string');
        }

        resources = [new ResourceRequest(
          bucketId,
          convenience.windowMs,
          convenience.limit,
          convenience.tokensRequested
        )];
      }

      if (!Array.isArray(resources)) {
        throw new RateLimitConfigurationError('resources resolver must return an array');
      }

      // Resolve latency guards
      let guards = staticGuards || [];
      if (hasGuards && typeof options.guards === 'function') {
        const evalGuards = options.guards(req, res);
        guards = isPromise(evalGuards) ? await evalGuards : evalGuards;
      }

      if (!Array.isArray(guards)) {
        throw new RateLimitConfigurationError('guards resolver must return an array');
      }

      if (!staticGuards) {
        guards = guards.map((value, index) => normalizeLatencyGuard(value, `guards[${index}]`));
      }

      // Resolve metrics label
      let metricsLabel = null;
      if (typeof options.metricsLabel === 'function') {
        metricsLabel = options.metricsLabel(req, res);
      } else if (typeof options.label === 'function') {
        metricsLabel = options.label(req, res);
      } else if (options.metricsLabel || options.label) {
        metricsLabel = options.metricsLabel || options.label;
      } else if (options.emitDefaultMetricsLabel || options.defaultMetricsLabel) {
        metricsLabel = defaultMetricsLabel(req, res);
      }

      // Perform rate limit check via RateLimitly RClient
      const { err, result } = await checkRateLimitAsync(client, resources || [], guards || [], metricsLabel);

      if (err) {
        if (!isRateLimitlyAvailabilityError(err)) {
          return next(err);
        }

        // Handle an actual RateLimitly availability failure.
        if (failOpen) {
          if (typeof options.onError === 'function') {
            options.onError(err, req, res);
          } else if (process.env.DEBUG || process.env.NODE_ENV !== 'production') {
            console.warn(`[rl-express] RateLimitly check failed (${err.name || 'Error'}: ${err.message}) - failing open`);
          }
          if (err && typeof err === 'object') {
            try {
              Object.defineProperty(err, 'message', { enumerable: true, configurable: true });
            } catch {
              // Ignore definition failure
            }
          }
          req[requestPropertyName] = {
            outcome: 'fail-open',
            admitted: true,
            error: err,
            result: null,
            limit,
            windowMs,
            tokensRequested,
            guardResults: [],
            resourceResults: [],
            serverId: null,
            requestId: null
          };
          if (reporterConfiguration) {
            attachLatencyReporter(
              req,
              res,
              client,
              reporterConfiguration,
              options.onLatencyReportError
            );
          }
          return next();
        }

        const unavailableErr = new RateLimitUnavailableError(
          `RateLimitly service unavailable: ${err.message}`,
          { cause: err, statusCode: 503 }
        );

        if (typeof options.errorHandler === 'function') {
          return options.errorHandler(unavailableErr, req, res, next, options);
        }

        return res.status(503).json({
          error: 'Service Unavailable',
          message: unavailableErr.message
        });
      }

      if (!result || typeof result !== 'object' || typeof result.success !== 'boolean') {
        return next(new ProtocolError('RateLimitly client returned no valid admission decision'));
      }

      const isAllowed = result.success;

      // Apply rate limit response headers
      setRateLimitHeaders(res, {
        options,
        result,
        limit,
        windowMs,
        tokensRequested,
        isAllowed
      });

      // Attach RateLimitly context to Request
      req[requestPropertyName] = {
        outcome: isAllowed ? 'granted' : 'rejected',
        admitted: isAllowed,
        error: null,
        result,
        limit,
        windowMs,
        tokensRequested,
        guardResults: result ? result.guardResults : [],
        resourceResults: result ? result.resourceResults : [],
        serverId: result ? result.serverId : null,
        requestId: result ? (result.requestId || null) : null
      };

      if (isAllowed) {
        // If latency reporting is configured, hook response finish
        if (reporterConfiguration) {
          attachLatencyReporter(
            req,
            res,
            client,
            reporterConfiguration,
            options.onLatencyReportError
          );
        }

        return next();
      }

      // Admission Denied (Rate limit exceeded or guard triggered)
      if (typeof options.onLimitReached === 'function') {
        options.onLimitReached(req, res, options, result);
      }

      return handler(req, res, next, options, result);
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  rateLimitly,
  rateLimit: rateLimitly // Alias matching express-rate-limit convention
};
