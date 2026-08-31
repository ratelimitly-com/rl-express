'use strict';

const {
  LatencyGuard,
  ServiceLatencyBlock
} = require('ratelimitly-client');
const { RateLimitConfigurationError } = require('./errors');

const UINT32_MAX = 0xFFFF_FFFF;
const MAX_LATENCY_TRACKER_NAME_BYTES = 255;
const DEFAULT_TTL_MS = 300000;
const DEFAULT_MAX_SAMPLES = 100;
const DEFAULT_MIN_SAMPLE_THRESHOLD = 8;

const DURATION_MULTIPLIERS = new Map([
  ['ms', 1],
  ['s', 1000],
  ['sec', 1000],
  ['second', 1000],
  ['seconds', 1000],
  ['m', 60000],
  ['min', 60000],
  ['minute', 60000],
  ['minutes', 60000],
  ['h', 3600000],
  ['hour', 3600000],
  ['hours', 3600000],
  ['d', 86400000],
  ['day', 86400000],
  ['days', 86400000]
]);

function configurationError(message, cause) {
  return new RateLimitConfigurationError(message, cause ? { cause } : undefined);
}

function validateUint32(value, name, { positive = false } = {}) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX || (positive && value === 0)) {
    throw configurationError(`${name} must be ${positive ? 'a positive' : 'a'} uint32 integer`);
  }
  return value;
}

function parseStrictDuration(value, name, { defaultValue, positive = false } = {}) {
  const configured = value === undefined ? defaultValue : value;
  let milliseconds;

  if (typeof configured === 'number') {
    milliseconds = configured;
  } else if (typeof configured === 'string') {
    const match = configured.trim().toLowerCase().match(
      /^(\d+(?:\.\d+)?)\s*(ms|s|sec|second|seconds|m|min|minute|minutes|h|hour|hours|d|day|days)$/
    );
    if (!match) {
      throw configurationError(`${name} must be an integer number of milliseconds or an explicit duration string`);
    }
    milliseconds = Number(match[1]) * DURATION_MULTIPLIERS.get(match[2]);
  } else {
    throw configurationError(`${name} must be an integer number of milliseconds or an explicit duration string`);
  }

  return validateUint32(milliseconds, name, { positive });
}

function validateTrackerName(value, name = 'latencyTrackerName') {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw configurationError(`${name} must be a non-empty string`);
  }
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength > MAX_LATENCY_TRACKER_NAME_BYTES) {
    throw configurationError(
      `${name} must be at most ${MAX_LATENCY_TRACKER_NAME_BYTES} UTF-8 bytes`
    );
  }
  return value;
}

class LatencyTracker {
  constructor(latencyTrackerName, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw configurationError('LatencyTracker options must be an object');
    }

    this.latencyTrackerName = validateTrackerName(latencyTrackerName);
    this.ttlMs = parseStrictDuration(options.ttlMs, 'ttlMs', {
      defaultValue: DEFAULT_TTL_MS,
      positive: true
    });
    this.maxSamples = validateUint32(
      options.maxSamples === undefined ? DEFAULT_MAX_SAMPLES : options.maxSamples,
      'maxSamples',
      { positive: true }
    );
    this.minSampleThreshold = validateUint32(
      options.minSampleThreshold === undefined
        ? DEFAULT_MIN_SAMPLE_THRESHOLD
        : options.minSampleThreshold,
      'minSampleThreshold'
    );

    Object.freeze(this);
  }
}

function latencyTracker(latencyTrackerName, options) {
  return new LatencyTracker(latencyTrackerName, options);
}

function trackerFromWireObject(value, name) {
  if (!value || typeof value !== 'object') {
    throw configurationError(`${name} must be a LatencyTracker-based wire object`);
  }
  return new LatencyTracker(value.latencyTrackerName, {
    ttlMs: value.ttlMs,
    maxSamples: value.maxSamples,
    minSampleThreshold: value.minSampleThreshold
  });
}

function requireLatencyTracker(value, name = 'tracker') {
  if (!(value instanceof LatencyTracker)) {
    throw configurationError(
      `${name} must be created with latencyTracker(name, options)`
    );
  }
  return value;
}

function createLatencyGuard(tracker, thresholdMs) {
  const definition = requireLatencyTracker(tracker);
  const threshold = parseStrictDuration(thresholdMs, 'thresholdMs');
  return Object.freeze(new LatencyGuard({
    ...definition,
    thresholdMs: threshold
  }));
}

function normalizeLatencyGuard(value, name = 'guard') {
  if (!(value instanceof LatencyGuard)) {
    throw configurationError(`${name} must be created with guard(tracker, thresholdMs)`);
  }
  const tracker = trackerFromWireObject(value, name);
  return createLatencyGuard(tracker, value.thresholdMs);
}

function createLatencyBlock(tracker, observedLatency) {
  const definition = requireLatencyTracker(tracker);
  const observed = validateUint32(observedLatency, 'observedLatency');
  return Object.freeze(new ServiceLatencyBlock({
    ...definition,
    observedLatency: observed
  }));
}

function normalizeLatencyBlock(value, name = 'latency report') {
  if (!(value instanceof ServiceLatencyBlock)) {
    throw configurationError(`${name} must be created with latencyBlock(tracker, observedLatency)`);
  }
  const tracker = trackerFromWireObject(value, name);
  return createLatencyBlock(tracker, value.observedLatency);
}

module.exports = {
  UINT32_MAX,
  MAX_LATENCY_TRACKER_NAME_BYTES,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_SAMPLES,
  DEFAULT_MIN_SAMPLE_THRESHOLD,
  LatencyTracker,
  latencyTracker,
  validateUint32,
  parseStrictDuration,
  requireLatencyTracker,
  createLatencyGuard,
  normalizeLatencyGuard,
  createLatencyBlock,
  normalizeLatencyBlock
};
