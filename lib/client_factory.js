'use strict';

const {
  RClient,
  RClientConfig,
  TenantConfig,
  AuthMethod,
  HaSchedule,
  RequestPolicy
} = require('ratelimitly-client');
const { decodeApiKey } = require('ratelimitly-client/api_key_codec');
const { RateLimitConfigurationError } = require('./errors');

// Client cache for shared singleton instances
const clientCache = new Map();

const REMOVED_CLIENT_OPTIONS = [
  'clientOptions',
  'timeoutMs',
  'retryAttempts',
  'dedupTtlMs',
  'serverStabilityThresholdMs'
];

/**
 * Return a stable, complete representation of an effective request policy.
 *
 * @param {RequestPolicy} policy
 * @returns {object}
 */
function requestPolicyIdentity(policy) {
  return {
    unitMs: policy.unitMs,
    replayCount: policy.replayCount,
    replayGap: {
      kind: policy.replayGap.kind,
      initialUnits: policy.replayGap.initialUnits,
      maxUnits: policy.replayGap.maxUnits,
      growth: policy.replayGap.growth
    },
    finalReceiveUnits: policy.finalReceiveUnits,
    completionDelivery: policy.completionDelivery
  };
}

/**
 * Snapshot and validate a policy so later caller mutations cannot change a
 * cached client's behavior without changing its cache identity.
 *
 * @param {RequestPolicy|object|null|undefined} configuredPolicy
 * @returns {RequestPolicy}
 */
function normalizeRequestPolicy(configuredPolicy) {
  if (configuredPolicy === null || configuredPolicy === undefined) {
    return new RequestPolicy();
  }

  try {
    const configuredGap = configuredPolicy.replayGap;
    const replayGap = configuredGap === null || configuredGap === undefined
      ? undefined
      : new HaSchedule(
        configuredGap.kind,
        configuredGap.initialUnits,
        configuredGap.maxUnits,
        configuredGap.growth
      );

    return new RequestPolicy({
      unitMs: configuredPolicy.unitMs,
      replayCount: configuredPolicy.replayCount,
      replayGap,
      finalReceiveUnits: configuredPolicy.finalReceiveUnits,
      completionDelivery: configuredPolicy.completionDelivery
    });
  } catch (cause) {
    throw new RateLimitConfigurationError('Invalid requestPolicy', { cause });
  }
}

/**
 * Reject settings removed with ratelimitly-client 2.x. Accepting them would
 * make an application look configured while the client silently ignores them.
 *
 * @param {object} options
 */
function rejectRemovedClientOptions(options) {
  for (const name of REMOVED_CLIENT_OPTIONS) {
    if (options[name] !== undefined) {
      throw new RateLimitConfigurationError(
        `${name} is no longer supported; configure requestPolicy directly or supply an initialized client`
      );
    }
  }
}

/**
 * Normalizes auth method string to AuthMethod enum values.
 *
 * @param {string} method - 'none' | 'cookie' | 'aes' | 'aes_gcm'
 * @returns {string} Normalized AuthMethod
 */
function normalizeAuthMethod(method) {
  if (!method) return AuthMethod.NONE;
  const lower = String(method).toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (lower === 'none') return AuthMethod.NONE;
  if (lower === 'cookie') return AuthMethod.COOKIE;
  if (lower === 'aes' || lower === 'aes_gcm' || lower === 'aes256' || lower === 'aes_256_gcm') return AuthMethod.AES_GCM;
  return method;
}

/**
 * Parse servers configuration from array, comma-separated string, or JSON string.
 *
 * @param {any} serversInput
 * @returns {Array<{ip: string, port: number}>|null}
 */
function parseServers(serversInput) {
  if (!serversInput) return null;
  if (Array.isArray(serversInput)) return serversInput;

  if (typeof serversInput === 'string') {
    const trimmed = serversInput.trim();
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // Fall through to comma-separated parser
      }
    }
    const servers = [];
    const parts = trimmed.split(',');
    for (const part of parts) {
      const [ip, portStr] = part.trim().split(':');
      if (ip) {
        servers.push({
          ip,
          port: portStr ? parseInt(portStr, 10) : 8080
        });
      }
    }
    return servers.length > 0 ? servers : null;
  }

  return null;
}

/**
 * Create or resolve an RClient instance from options.
 *
 * @param {object} [options={}] - Client configuration options
 * @returns {RClient} Configured RClient instance
 */
function resolveClient(options = {}) {
  const rootOptions = options && typeof options === 'object' ? options : {};

  // If an RClient instance is directly passed, use it
  if (rootOptions instanceof RClient || typeof rootOptions.checkRateLimit === 'function') {
    return rootOptions;
  }
  if (rootOptions.client && (
    rootOptions.client instanceof RClient ||
    typeof rootOptions.client.checkRateLimit === 'function'
  )) {
    return rootOptions.client;
  }

  rejectRemovedClientOptions(rootOptions);

  const tenantOpts = rootOptions.tenant || rootOptions;
  const requestPolicy = normalizeRequestPolicy(rootOptions.requestPolicy);
  const dnsRefreshIntervalS = rootOptions.dnsRefreshIntervalS || 300;

  let dnsName = tenantOpts.dnsName || tenantOpts.tenantDnsName || process.env.RATELIMITLY_DNS_NAME || process.env.RCLIENT_TARGET_HOST || null;
  const configuredAuthKey = tenantOpts.authKey || tenantOpts.credential || tenantOpts.authSecret || process.env.RATELIMITLY_AUTH_KEY || null;
  let keyId = tenantOpts.keyId !== undefined ? tenantOpts.keyId : (process.env.RATELIMITLY_KEY_ID || null);
  let authMethod = normalizeAuthMethod(tenantOpts.authMethod || process.env.RATELIMITLY_AUTH_METHOD);
  let servers = parseServers(tenantOpts.servers || process.env.RATELIMITLY_SERVERS);
  let steeringFeedback = Boolean(tenantOpts.steeringFeedback);

  if (typeof configuredAuthKey !== 'string' || configuredAuthKey.trim().length === 0) {
    throw new RateLimitConfigurationError(
      'A valid RateLimitly API key is required unless an initialized client is supplied'
    );
  }

  const authKey = configuredAuthKey.trim();
  let decoded;
  try {
    decoded = decodeApiKey(authKey);
  } catch (cause) {
    throw new RateLimitConfigurationError('Invalid RateLimitly API key', { cause });
  }

  if (!decoded || decoded.keyId === null || decoded.keyId === undefined) {
    throw new RateLimitConfigurationError('Invalid RateLimitly API key: missing key ID');
  }

  if (keyId === null || keyId === undefined) {
    keyId = decoded.keyId;
  }
  if (!tenantOpts.authMethod && !process.env.RATELIMITLY_AUTH_METHOD) {
    authMethod = normalizeAuthMethod(decoded.authMethod);
  }
  if (!dnsName) {
    dnsName = `c-${decoded.keyId.toString()}.p0.ratelimitly.com`;
  }

  // Create a cache key for singleton sharing
  const cacheKey = JSON.stringify({
    dnsName,
    keyId: String(keyId),
    authMethod,
    authKey,
    servers: servers || [],
    steeringFeedback,
    requestPolicy: requestPolicyIdentity(requestPolicy),
    dnsRefreshIntervalS
  });

  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  const tenantConfig = new TenantConfig(
    dnsName,
    keyId,
    authMethod,
    authKey,
    servers,
    steeringFeedback
  );

  const rClientConfig = new RClientConfig(tenantConfig, {
    requestPolicy,
    dnsRefreshIntervalS
  });

  const client = new RClient(rClientConfig);
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Destroy and clear all middleware-owned cached client instances.
 */
function closeSharedClients() {
  const clients = Array.from(clientCache.values());
  clientCache.clear();
  const errors = [];

  for (const client of clients) {
    if (client && typeof client.destroy === 'function') {
      try {
        client.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to destroy one or more shared RateLimitly clients');
  }
}

module.exports = {
  resolveClient,
  closeSharedClients,
  normalizeAuthMethod,
  parseServers
};
