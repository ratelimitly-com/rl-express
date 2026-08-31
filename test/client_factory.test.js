'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { resolveClient, closeSharedClients, normalizeAuthMethod, parseServers } = require('../lib/client_factory');
const { RateLimitConfigurationError } = require('../lib/errors');
const {
  RClient,
  AuthMethod,
  HaSchedule,
  RequestPolicy
} = require('ratelimitly-client');
const { TEST_KEY_ID, createTestApiKey } = require('./fixtures');

describe('Client Factory', () => {
  const sampleApiKey = createTestApiKey();

  afterEach(() => {
    delete process.env.RATELIMITLY_AUTH_KEY;
    closeSharedClients();
  });

  it('reuses existing RClient when passed directly', () => {
    const rawClient = resolveClient({
      tenantDnsName: 'ratelimitly.example.com',
      authKey: sampleApiKey
    });
    assert.ok(rawClient instanceof RClient);

    const reused = resolveClient({ client: rawClient });
    assert.equal(rawClient, reused);
  });

  it('shares singleton clients with identical tenant configuration', () => {
    const client1 = resolveClient({
      dnsName: 'srv.example.com',
      authKey: sampleApiKey
    });

    const client2 = resolveClient({
      dnsName: 'srv.example.com',
      authKey: sampleApiKey
    });

    assert.equal(client1, client2);
  });

  it('destroys every middleware-owned client before clearing the cache', () => {
    const client1 = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({ unitMs: 10 })
    });
    const client2 = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({ unitMs: 15 })
    });
    let client1DestroyCount = 0;
    let client2DestroyCount = 0;
    client1.destroy = () => { client1DestroyCount += 1; };
    client2.destroy = () => { client2DestroyCount += 1; };

    closeSharedClients();

    assert.equal(client1DestroyCount, 1);
    assert.equal(client2DestroyCount, 1);
    assert.notEqual(resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({ unitMs: 10 })
    }), client1);
  });

  it('does not destroy an application-owned client', () => {
    let destroyCount = 0;
    const client = {
      checkRateLimit() {},
      destroy() { destroyCount += 1; }
    };

    assert.equal(resolveClient({ client }), client);
    closeSharedClients();

    assert.equal(destroyCount, 0);
  });

  it('attempts every destruction and reports collected failures after clearing the cache', () => {
    const firstError = new Error('first destroy failed');
    const secondError = new Error('second destroy failed');
    const client1 = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({ unitMs: 10 })
    });
    const client2 = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({ unitMs: 15 })
    });
    client1.destroy = () => { throw firstError; };
    client2.destroy = () => { throw secondError; };

    assert.throws(
      () => closeSharedClients(),
      err => err instanceof AggregateError &&
        err.errors.length === 2 &&
        err.errors[0] === firstError &&
        err.errors[1] === secondError
    );

    assert.notEqual(resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({ unitMs: 10 })
    }), client1);
  });

  it('shares singleton clients with semantically identical request policies', () => {
    const policyOptions = {
      unitMs: 10,
      replayCount: 2,
      replayGap: HaSchedule.linear(1, 1, 3),
      finalReceiveUnits: 1,
      completionDelivery: false
    };

    const client1 = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy(policyOptions)
    });
    const client2 = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({
        ...policyOptions,
        replayGap: HaSchedule.linear(1, 1, 3)
      })
    });

    assert.equal(client1, client2);
  });

  it('isolates singleton clients by every effective request-policy field', () => {
    const baseOptions = {
      unitMs: 10,
      replayCount: 2,
      replayGap: HaSchedule.exponential(1, 2, 4),
      finalReceiveUnits: 1,
      completionDelivery: true
    };
    const baseClient = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy(baseOptions)
    });
    const variants = [
      { ...baseOptions, unitMs: 15 },
      { ...baseOptions, replayCount: 3 },
      { ...baseOptions, replayGap: HaSchedule.linear(1, 2, 4) },
      { ...baseOptions, replayGap: HaSchedule.exponential(2, 2, 4) },
      { ...baseOptions, replayGap: HaSchedule.exponential(1, 2, 8) },
      { ...baseOptions, replayGap: HaSchedule.exponential(1, 3, 4) },
      { ...baseOptions, finalReceiveUnits: 2 },
      { ...baseOptions, completionDelivery: false }
    ];

    for (const policyOptions of variants) {
      const client = resolveClient({
        authKey: sampleApiKey,
        requestPolicy: new RequestPolicy(policyOptions)
      });
      assert.notEqual(client, baseClient);
      assert.equal(client.config.requestPolicy.unitMs, policyOptions.unitMs);
      assert.equal(client.config.requestPolicy.replayCount, policyOptions.replayCount);
      assert.deepEqual(client.config.requestPolicy.replayGap, policyOptions.replayGap);
      assert.equal(client.config.requestPolicy.finalReceiveUnits, policyOptions.finalReceiveUnits);
      assert.equal(client.config.requestPolicy.completionDelivery, policyOptions.completionDelivery);
    }
  });

  it('snapshots a request policy before placing its client in the cache', () => {
    const configuredPolicy = new RequestPolicy({ unitMs: 10 });
    const originalClient = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: configuredPolicy
    });

    configuredPolicy.unitMs = 15;

    const originalPolicyClient = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: new RequestPolicy({ unitMs: 10 })
    });
    const changedPolicyClient = resolveClient({
      authKey: sampleApiKey,
      requestPolicy: configuredPolicy
    });

    assert.equal(originalPolicyClient, originalClient);
    assert.notEqual(changedPolicyClient, originalClient);
    assert.equal(originalClient.config.requestPolicy.unitMs, 10);
    assert.equal(changedPolicyClient.config.requestPolicy.unitMs, 15);
  });

  it('rejects removed client configuration instead of silently ignoring it', () => {
    const removedOptions = [
      ['clientOptions', { requestPolicy: new RequestPolicy() }],
      ['timeoutMs', 1000],
      ['retryAttempts', 2],
      ['dedupTtlMs', 300],
      ['serverStabilityThresholdMs', 30000]
    ];

    for (const [name, value] of removedOptions) {
      assert.throws(
        () => resolveClient({ authKey: sampleApiKey, [name]: value }),
        (err) => err instanceof RateLimitConfigurationError &&
          err.message.includes(name) &&
          /requestPolicy|initialized client/i.test(err.message)
      );
    }
  });

  it('accepts an explicitly supplied compatible client without an API key', () => {
    const client = { checkRateLimit() {} };
    assert.equal(resolveClient({ client }), client);
  });

  it('rejects missing API-key configuration instead of fabricating a tenant', () => {
    delete process.env.RATELIMITLY_AUTH_KEY;

    assert.throws(
      () => resolveClient(),
      (err) => err instanceof RateLimitConfigurationError && /API key/i.test(err.message)
    );
  });

  it('rejects an invalid API key during client construction', () => {
    assert.throws(
      () => resolveClient({ authKey: 'not-a-ratelimitly-api-key' }),
      (err) => err instanceof RateLimitConfigurationError && /invalid.*API key/i.test(err.message)
    );
  });

  it('derives tenant DNS domain from Bech32 authKey option when dnsName is omitted', () => {
    const client = resolveClient({
      authKey: sampleApiKey
    });

    assert.ok(client instanceof RClient);
    assert.equal(client.config.tenant.dnsName, `c-${TEST_KEY_ID}.p0.ratelimitly.com`);
    assert.equal(client.config.tenant.keyId, TEST_KEY_ID);
    assert.equal(client.config.tenant.authMethod, AuthMethod.NONE);
  });

  it('reads RATELIMITLY_AUTH_KEY environment variable and derives tenant domain', () => {
    process.env.RATELIMITLY_AUTH_KEY = sampleApiKey;

    const client = resolveClient();
    assert.ok(client instanceof RClient);
    assert.equal(client.config.tenant.dnsName, `c-${TEST_KEY_ID}.p0.ratelimitly.com`);
    assert.equal(client.config.tenant.keyId, TEST_KEY_ID);
    assert.equal(client.config.tenant.authMethod, AuthMethod.NONE);
  });

  it('normalizes auth methods properly', () => {
    assert.equal(normalizeAuthMethod('none'), AuthMethod.NONE);
    assert.equal(normalizeAuthMethod('cookie'), AuthMethod.COOKIE);
    assert.equal(normalizeAuthMethod('aes'), AuthMethod.AES_GCM);
    assert.equal(normalizeAuthMethod('aes_gcm'), AuthMethod.AES_GCM);
    assert.equal(normalizeAuthMethod('aes-256-gcm'), AuthMethod.AES_GCM);
  });

  it('parses server strings properly', () => {
    const s1 = parseServers('127.0.0.1:8080,10.0.0.2:9090');
    assert.deepEqual(s1, [
      { ip: '127.0.0.1', port: 8080 },
      { ip: '10.0.0.2', port: 9090 }
    ]);

    const s2 = parseServers('[{"ip":"127.0.0.1","port":8080}]');
    assert.deepEqual(s2, [
      { ip: '127.0.0.1', port: 8080 }
    ]);
  });
});
