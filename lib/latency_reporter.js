'use strict';

const { isPromise } = require('./utils');
const { resolveClient } = require('./client_factory');
const { RateLimitConfigurationError } = require('./errors');
const {
  LatencyTracker,
  requireLatencyTracker,
  createLatencyBlock,
  normalizeLatencyBlock
} = require('./latency_tracker');

function reportFailure(error, req, res, onLatencyReportError) {
  if (typeof onLatencyReportError === 'function') {
    try {
      const hookResult = onLatencyReportError(error, req, res);
      if (isPromise(hookResult)) {
        hookResult.catch(hookError => {
          console.error('[rl-express] onLatencyReportError failed', hookError);
        });
      }
      return;
    } catch (hookError) {
      console.error('[rl-express] onLatencyReportError failed', hookError);
    }
  }
  console.error('[rl-express] Latency report failed', error);
}

function normalizeStaticTrackers(value, name) {
  const configured = Array.isArray(value) ? value : [value];
  if (configured.length === 0) {
    throw new RateLimitConfigurationError(`${name} must not be an empty array`);
  }
  return configured.map((tracker, index) => {
    const validated = requireLatencyTracker(tracker, `${name}[${index}]`);
    return new LatencyTracker(validated.latencyTrackerName, validated);
  });
}

/**
 * Static sources are explicit trackers measured by the middleware. A resolver
 * returns ServiceLatencyBlock values for dynamic reporting.
 */
function normalizeReporterConfiguration(value, name = 'reportLatency') {
  if (typeof value === 'function') {
    return Object.freeze({ kind: 'resolver', resolve: value });
  }
  if (value instanceof LatencyTracker || Array.isArray(value)) {
    return Object.freeze({
      kind: 'trackers',
      trackers: Object.freeze(normalizeStaticTrackers(value, name))
    });
  }
  throw new RateLimitConfigurationError(
    `${name} must be a LatencyTracker, an array of LatencyTracker values, or a report resolver`
  );
}

function normalizeResolvedReports(value) {
  if (!Array.isArray(value)) {
    throw new RateLimitConfigurationError('Latency report resolver must return an array');
  }
  return value.map((report, index) => normalizeLatencyBlock(report, `latency reports[${index}]`));
}

function attachLatencyReporter(
  req,
  res,
  client,
  reporterConfiguration,
  onLatencyReportError
) {
  if (!reporterConfiguration || !client) return;

  const configuration = reporterConfiguration.kind
    ? reporterConfiguration
    : normalizeReporterConfiguration(reporterConfiguration);
  const startHrTime = process.hrtime.bigint();
  let reported = false;
  let failureReported = false;
  const fail = (error) => {
    if (failureReported) return;
    failureReported = true;
    reportFailure(error, req, res, onLatencyReportError);
  };

  const doReport = async () => {
    if (reported) return;
    reported = true;

    try {
      const elapsedMs = Number(process.hrtime.bigint() - startHrTime) / 1e6;
      const observedLatency = Math.ceil(elapsedMs);
      let blocks;

      if (configuration.kind === 'resolver') {
        const value = configuration.resolve(req, res, observedLatency);
        blocks = normalizeResolvedReports(isPromise(value) ? await value : value);
      } else {
        blocks = configuration.trackers.map(tracker => createLatencyBlock(tracker, observedLatency));
      }

      if (blocks.length === 0) return;

      let callbackHandled = false;
      client.reportLatency(blocks, (error) => {
        if (callbackHandled) return;
        callbackHandled = true;
        if (error) fail(error);
      });
    } catch (error) {
      fail(error);
    }
  };

  res.once('finish', doReport);
  res.once('close', doReport);
}

function resolveStandaloneReporterConfiguration(options) {
  const configured = ['tracker', 'trackers', 'reports'].filter(name => options[name] !== undefined);
  if (configured.length !== 1) {
    throw new RateLimitConfigurationError(
      'Configure exactly one of tracker, trackers, or reports for latencyReporter'
    );
  }
  const name = configured[0];
  return normalizeReporterConfiguration(options[name], name);
}

function latencyReporterMiddleware(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RateLimitConfigurationError('Latency reporter options must be an object');
  }
  if (options.onLatencyReportError !== undefined && typeof options.onLatencyReportError !== 'function') {
    throw new RateLimitConfigurationError('onLatencyReportError must be a function');
  }
  const reporterConfiguration = resolveStandaloneReporterConfiguration(options);
  const client = resolveClient(options);
  if (typeof client.reportLatency !== 'function') {
    throw new RateLimitConfigurationError('Configured client must implement reportLatency');
  }

  return function latencyReporter(req, res, next) {
    try {
      if (typeof options.skip === 'function' && options.skip(req, res)) {
        return next();
      }

      attachLatencyReporter(
        req,
        res,
        client,
        reporterConfiguration,
        options.onLatencyReportError
      );
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  normalizeReporterConfiguration,
  attachLatencyReporter,
  latencyReporterMiddleware
};
