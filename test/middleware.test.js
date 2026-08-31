'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const rateLimitly = require('../index');
const { guard, latencyTracker } = rateLimitly;
const { RateLimitResult, ResourceResult, GuardResult, ResourceRequest } = require('ratelimitly-client');

class MockClient {
  constructor(handler) {
    this.handler = handler || ((resources, guards, label, cb) => {
      const resourceResults = resources.map(resource => new ResourceResult(resource.bucketId, 0, 1));
      cb(null, new RateLimitResult(true, [], resourceResults, 1n));
    });
    this.calls = [];
    this.latencyReports = [];
  }

  checkRateLimit(resources, guards, label, cb) {
    this.calls.push({ resources, guards, label });
    this.handler(resources, guards, label, cb);
  }

  reportLatency(blocks, cb) {
    this.latencyReports.push(blocks);
    if (cb) cb(null);
  }
}

function createMockReqRes(options = {}) {
  const headers = { ...options.headers };
  const resHeaders = {};

  const req = {
    method: options.method || 'GET',
    url: options.url || '/api/test',
    path: options.path || '/api/test',
    ip: options.ip || '192.168.1.100',
    headers,
    ...options.req
  };

  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      resHeaders[name.toLowerCase()] = String(value);
      resHeaders[name] = String(value);
    },
    getHeader(name) {
      return resHeaders[name.toLowerCase()] || resHeaders[name];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.headersSent = true;
      this.body = body;
      return this;
    },
    json(body) {
      this.headersSent = true;
      this.body = body;
      return this;
    },
    once(event, fn) {
      if (!this._listeners) this._listeners = {};
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },
    emit(event, ...args) {
      if (this._listeners && this._listeners[event]) {
        for (const fn of this._listeners[event]) fn(...args);
      }
    },
    _resHeaders: resHeaders
  };

  return { req, res };
}

describe('rateLimitly middleware', () => {
  it('allows request when RateLimitly permits it', async () => {
    const mockClient = new MockClient();
    const mw = rateLimitly({
      client: mockClient,
      bucketId: 'checkout',
      limit: 10,
      window: '1s'
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(req.rateLimitly.outcome, 'granted');
    assert.equal(req.rateLimitly.admitted, true);
    assert.equal('success' in req.rateLimitly, false);
    assert.equal(mockClient.calls.length, 1);
    assert.equal(mockClient.calls[0].resources[0].bucketId, 'checkout');
    assert.equal(mockClient.calls[0].resources[0].windowSizeMs, 1000);
    assert.equal(mockClient.calls[0].resources[0].rateLimit, 10);
  });

  it('blocks request with 429 when rate limit is exceeded', async () => {
    const mockClient = new MockClient((resources, guards, label, cb) => {
      cb(null, new RateLimitResult(false, [], [new ResourceResult(resources[0].bucketId, 1, 10)], 1n));
    });

    const mw = rateLimitly({
      client: mockClient,
      bucketId: 'checkout',
      limit: 5,
      window: '1s',
      standardHeaders: true,
      message: 'Rate limit exceeded'
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body, 'Rate limit exceeded');
    assert.equal(req.rateLimitly.outcome, 'rejected');
    assert.equal(req.rateLimitly.admitted, false);
    assert.equal(res.getHeader('RateLimit-Remaining'), '0');
    assert.equal(res.getHeader('Retry-After'), '1');
  });

  it('supports custom keyGenerator', async () => {
    const mockClient = new MockClient();
    const mw = rateLimitly({
      client: mockClient,
      keyGenerator: (req) => `user_${req.headers['x-user-id'] || 'anon'}`,
      limit: 10,
      window: '1s'
    });

    const { req, res } = createMockReqRes({ headers: { 'x-user-id': 'u123' } });
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls[0].resources[0].bucketId, 'rl:user_u123');
  });

  it('supports dynamic resources resolver function for multi-resource atomic checks', async () => {
    const mockClient = new MockClient();
    const mw = rateLimitly({
      client: mockClient,
      resources: (req) => [
        new ResourceRequest(`global_limit`, 1000, 100, 1),
        new ResourceRequest(`client_${req.ip}`, 1000, 5, 1)
      ]
    });

    const { req, res } = createMockReqRes({ ip: '10.0.0.1' });
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls[0].resources.length, 2);
    assert.equal(mockClient.calls[0].resources[0].bucketId, 'global_limit');
    assert.equal(mockClient.calls[0].resources[1].bucketId, 'client_10.0.0.1');
  });

  it('resolves an empty logical request without creating an implicit resource', async () => {
    const mockClient = new MockClient();
    const mw = rateLimitly({ client: mockClient });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls.length, 1);
    assert.deepEqual(mockClient.calls[0].resources, []);
    assert.deepEqual(mockClient.calls[0].guards, []);
    assert.equal(req.rateLimitly.outcome, 'granted');
    assert.equal(req.rateLimitly.admitted, true);
  });

  it('sends a genuine guard-only request without consuming a resource', async () => {
    const mockClient = new MockClient();
    const mw = rateLimitly({
      client: mockClient,
      guard: guard(latencyTracker('inventory'), 200)
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls.length, 1);
    assert.deepEqual(mockClient.calls[0].resources, []);
    assert.equal(mockClient.calls[0].guards.length, 1);
    assert.equal(mockClient.calls[0].guards[0].latencyTrackerName, 'inventory');
  });

  it('treats explicit empty resource and guard lists as an empty request', async () => {
    const mockClient = new MockClient();
    const mw = rateLimitly({
      client: mockClient,
      resources: [],
      guards: []
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls.length, 1);
    assert.deepEqual(mockClient.calls[0].resources, []);
    assert.deepEqual(mockClient.calls[0].guards, []);
    assert.equal(req.rateLimitly.outcome, 'granted');
    assert.equal(req.rateLimitly.admitted, true);
  });

  it('rejects incomplete convenience resource configuration', () => {
    const mockClient = new MockClient();

    assert.throws(
      () => rateLimitly({ client: mockClient, bucketId: 'checkout', limit: 10 }),
      err => err && err.name === 'RateLimitConfigurationError' && /window/.test(err.message)
    );
    assert.throws(
      () => rateLimitly({ client: mockClient, limit: 10, window: '1s' }),
      err => err && err.name === 'RateLimitConfigurationError' && /bucketId|keyGenerator/.test(err.message)
    );
  });

  it('rejects convenience values that do not fit the wire protocol', () => {
    const mockClient = new MockClient();
    const base = { client: mockClient, bucketId: 'checkout', window: '1s', limit: 10 };

    for (const options of [
      { ...base, limit: 0 },
      { ...base, tokens: 0 },
      { ...base, window: 0x1_0000_0000 }
    ]) {
      assert.throws(
        () => rateLimitly(options),
        err => err && err.name === 'RateLimitConfigurationError' && /positive uint32/.test(err.message)
      );
    }
  });

  it('rejects mixed explicit and convenience resource configuration', () => {
    const mockClient = new MockClient();

    assert.throws(
      () => rateLimitly({
        client: mockClient,
        resources: [new ResourceRequest('checkout', 1000, 10, 1)],
        bucketId: 'other',
        limit: 10,
        window: '1s'
      }),
      err => err && err.name === 'RateLimitConfigurationError' && /mix/.test(err.message)
    );
  });

  it('rejects ambiguous or invalid request-shape configuration', () => {
    const mockClient = new MockClient();

    assert.throws(
      () => rateLimitly({
        client: mockClient,
        bucketId: 'checkout',
        keyGenerator: () => 'client',
        limit: 10,
        window: '1s'
      }),
      err => err && err.name === 'RateLimitConfigurationError' && /not both/.test(err.message)
    );
    assert.throws(
      () => rateLimitly({ client: mockClient, resource: null }),
      err => err && err.name === 'RateLimitConfigurationError' && /ResourceRequest/.test(err.message)
    );
    assert.throws(
      () => rateLimitly({ client: mockClient, guards: {}, guard: {} }),
      err => err && err.name === 'RateLimitConfigurationError' && /both guard and guards/.test(err.message)
    );
  });

  it('propagates invalid dynamic request shapes as configuration errors', async () => {
    const mockClient = new MockClient();
    const invalidResources = rateLimitly({
      client: mockClient,
      resources: () => ({ bucketId: 'not-an-array' })
    });
    const invalidIdentity = rateLimitly({
      client: mockClient,
      bucketId: () => '',
      limit: 10,
      window: '1s'
    });

    for (const mw of [invalidResources, invalidIdentity]) {
      const { req, res } = createMockReqRes();
      let nextError;
      await mw(req, res, err => { nextError = err; });
      assert.equal(nextError?.name, 'RateLimitConfigurationError');
    }
    assert.equal(mockClient.calls.length, 0);
  });

  it('skips requests when skip function returns true', async () => {
    const mockClient = new MockClient();
    const mw = rateLimitly({
      client: mockClient,
      skip: (req) => req.path === '/api/health'
    });

    const { req, res } = createMockReqRes({ path: '/api/health' });
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls.length, 0);
  });

  it('rejects post-response skip settings that cannot undo admission', () => {
    const mockClient = new MockClient();
    const removedOptions = [
      ['skipSuccessfulRequests', true],
      ['skipFailedRequests', true],
      ['requestWasSuccessful', () => true]
    ];

    for (const [name, value] of removedOptions) {
      assert.throws(
        () => rateLimitly({ client: mockClient, [name]: value }),
        err => err &&
          err.name === 'RateLimitConfigurationError' &&
          err.message.includes(name) &&
          /before admission/i.test(err.message)
      );
    }
  });

  it('supports custom handler and onLimitReached', async () => {
    let limitReachedCalled = false;
    let customHandlerCalled = false;

    const mockClient = new MockClient((resources, guards, label, cb) => {
      cb(null, new RateLimitResult(false, [], [new ResourceResult('b1', 1, 5)], 1n));
    });

    const mw = rateLimitly({
      client: mockClient,
      bucketId: 'checkout',
      limit: 5,
      window: '1s',
      onLimitReached: () => {
        limitReachedCalled = true;
      },
      handler: (req, res) => {
        customHandlerCalled = true;
        res.status(429).json({ error: 'custom_denied', code: 429 });
      }
    });

    const { req, res } = createMockReqRes();
    await mw(req, res, () => {});

    assert.equal(limitReachedCalled, true);
    assert.equal(customHandlerCalled, true);
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.body, { error: 'custom_denied', code: 429 });
  });
});
