'use strict';

const {
  RClient,
  RClientConfig,
  TenantConfig,
  RequestPolicy,
  HaSchedule,
  ResourceRequest,
  LatencyGuard,
  ServiceLatencyBlock,
  RateLimitResult,
  GuardResult,
  ResourceResult,
  AuthMethod,
  RateLimitError,
  TimeoutError,
  AuthenticationError,
  ProtocolError
} = require('ratelimitly-client');

const { decodeApiKey, encodeApiKey } = require('ratelimitly-client/api_key_codec');

const { rateLimitly, rateLimit } = require('./lib/middleware');
const { latencyGuardMiddleware } = require('./lib/latency_guard');
const { attachLatencyReporter, latencyReporterMiddleware } = require('./lib/latency_reporter');
const {
  LatencyTracker,
  latencyTracker,
  createLatencyGuard,
  createLatencyBlock
} = require('./lib/latency_tracker');
const { resolveClient, closeSharedClients } = require('./lib/client_factory');
const {
  RateLimitDeniedError,
  RateLimitUnavailableError,
  RateLimitConfigurationError
} = require('./lib/errors');
const { parseDuration, getClientIp, defaultKeyGenerator, defaultMetricsLabel } = require('./lib/utils');
const { setRateLimitHeaders } = require('./lib/headers');

/**
 * Fluent builder helper to create a ResourceRequest.
 *
 * @param {string} bucketId
 * @param {number|string} window
 * @param {number} limit
 * @param {number} [tokens=1]
 * @returns {ResourceRequest}
 */
function resource(bucketId, window, limit, tokens = 1) {
  const windowMs = parseDuration(window, 60000);
  return new ResourceRequest(bucketId, windowMs, limit, tokens);
}

/**
 * Fluent builder helper to create a LatencyGuard.
 *
 * @param {LatencyTracker} tracker
 * @param {number|string} thresholdMs
 * @returns {LatencyGuard}
 */
function guard(tracker, thresholdMs) {
  return createLatencyGuard(tracker, thresholdMs);
}

/**
 * Fluent builder helper to create a ServiceLatencyBlock.
 *
 * @param {LatencyTracker} tracker
 * @param {number} observedLatency
 * @returns {ServiceLatencyBlock}
 */
function latencyBlock(tracker, observedLatency) {
  return createLatencyBlock(tracker, observedLatency);
}

// Export main factory as default and named exports
module.exports = rateLimitly;
module.exports.rateLimitly = rateLimitly;
module.exports.rateLimit = rateLimit;
module.exports.default = rateLimitly;

// Helper middlewares
module.exports.latencyGuard = latencyGuardMiddleware;
module.exports.latencyReporter = latencyReporterMiddleware;
module.exports.attachLatencyReporter = attachLatencyReporter;

// Builder helpers
module.exports.resource = resource;
module.exports.LatencyTracker = LatencyTracker;
module.exports.latencyTracker = latencyTracker;
module.exports.guard = guard;
module.exports.latencyBlock = latencyBlock;
module.exports.createLatencyGuard = createLatencyGuard;
module.exports.createLatencyBlock = createLatencyBlock;

// Client management
module.exports.resolveClient = resolveClient;
module.exports.createClient = resolveClient;
module.exports.closeSharedClients = closeSharedClients;

// Errors
module.exports.RateLimitDeniedError = RateLimitDeniedError;
module.exports.RateLimitUnavailableError = RateLimitUnavailableError;
module.exports.RateLimitConfigurationError = RateLimitConfigurationError;

// Utilities
module.exports.parseDuration = parseDuration;
module.exports.getClientIp = getClientIp;
module.exports.defaultKeyGenerator = defaultKeyGenerator;
module.exports.defaultMetricsLabel = defaultMetricsLabel;
module.exports.setRateLimitHeaders = setRateLimitHeaders;

// Re-exports from ratelimitly-client
module.exports.RClient = RClient;
module.exports.RClientConfig = RClientConfig;
module.exports.TenantConfig = TenantConfig;
module.exports.RequestPolicy = RequestPolicy;
module.exports.HaSchedule = HaSchedule;
module.exports.ResourceRequest = ResourceRequest;
module.exports.LatencyGuard = LatencyGuard;
module.exports.ServiceLatencyBlock = ServiceLatencyBlock;
module.exports.RateLimitResult = RateLimitResult;
module.exports.GuardResult = GuardResult;
module.exports.ResourceResult = ResourceResult;
module.exports.AuthMethod = AuthMethod;
module.exports.RateLimitError = RateLimitError;
module.exports.TimeoutError = TimeoutError;
module.exports.AuthenticationError = AuthenticationError;
module.exports.ProtocolError = ProtocolError;

// API key codec utilities
module.exports.decodeApiKey = decodeApiKey;
module.exports.encodeApiKey = encodeApiKey;
