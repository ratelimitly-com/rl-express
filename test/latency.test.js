'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  rateLimitly,
  latencyGuard,
  latencyReporter,
  latencyTracker,
  guard,
  latencyBlock
} = require('../index');
const {
  RateLimitResult,
  GuardResult,
  ResourceResult,
  LatencyGuard,
  ServiceLatencyBlock,
  AuthenticationError,
  TimeoutError
} = require('ratelimitly-client');

class MockClient {
  constructor() {
    this.calls = [];
    this.reports = [];
  }

  checkRateLimit(resources, guards, label, cb) {
    this.calls.push({ resources, guards, label });
    // If any guard has threshold < 100, simulate failing guard
    const guardResults = (guards || []).map(g => {
      const passed = g.thresholdMs >= 100;
      return new GuardResult(g.latencyTrackerName, g.thresholdMs, passed ? 50 : 250, passed);
    });
    const allPassed = guardResults.every(g => g.passed);
    cb(null, new RateLimitResult(allPassed, guardResults, [], 1n));
  }

  reportLatency(blocks, cb) {
    this.reports.push(blocks);
    if (cb) cb(null);
  }
}

function createMockReqRes() {
  const resHeaders = {};
  const listeners = {};

  const req = {
    method: 'GET',
    url: '/api/demo/slow/cust-123',
    path: '/api/demo/slow/cust-123',
    baseUrl: '/api/demo',
    route: { path: '/slow/:customerId' },
    ip: '127.0.0.1',
    headers: {}
  };

  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(k, v) {
      resHeaders[k.toLowerCase()] = String(v);
    },
    getHeader(k) {
      return resHeaders[k.toLowerCase()];
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
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    emit(event, ...args) {
      if (listeners[event]) {
        for (const fn of listeners[event]) fn(...args);
      }
    }
  };

  return { req, res };
}

describe('Latency Guards and Reporting', () => {
  it('allows request when latency guard passes', async () => {
    const mockClient = new MockClient();
    const tracker = latencyTracker('customer-db');
    const mw = rateLimitly({
      client: mockClient,
      guard: guard(tracker, 250)
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls[0].guards.length, 1);
    assert.equal(mockClient.calls[0].guards[0].latencyTrackerName, 'customer-db');
    assert.equal(mockClient.calls[0].guards[0].thresholdMs, 250);
  });

  it('sheds load with 429 when latency guard is triggered', async () => {
    const mockClient = new MockClient();
    const tracker = latencyTracker('slow-db');
    const mw = rateLimitly({
      client: mockClient,
      guard: guard(tracker, 50) // Will fail in our mock client
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
  });

  it('measures latency and sends report on response finish', async () => {
    const mockClient = new MockClient();
    const tracker = latencyTracker('slow-db');
    const mw = rateLimitly({
      client: mockClient,
      reportLatency: tracker
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);

    // Simulate response completion
    res.emit('finish');

    assert.equal(mockClient.reports.length, 1);
    assert.equal(mockClient.reports[0].length, 1);
    assert.equal(mockClient.reports[0][0].latencyTrackerName, 'slow-db');
    assert.ok(mockClient.reports[0][0].observedLatency >= 0);
  });

  it('supports builder functions guard() and latencyBlock()', () => {
    const tracker = latencyTracker('auth-service', { ttlMs: '1m', maxSamples: 50 });
    const g = guard(tracker, '200ms');
    assert.ok(g instanceof LatencyGuard);
    assert.equal(g.latencyTrackerName, 'auth-service');
    assert.equal(g.thresholdMs, 200);
    assert.equal(g.ttlMs, 60000);
    assert.equal(g.maxSamples, 50);
    assert.equal(Object.hasOwn(g, 'bufferSize'), false);

    const reportTracker = latencyTracker('auth-service', { ttlMs: '30s' });
    const b = latencyBlock(reportTracker, 45);
    assert.ok(b instanceof ServiceLatencyBlock);
    assert.equal(b.latencyTrackerName, 'auth-service');
    assert.equal(b.observedLatency, 45);
    assert.equal(b.ttlMs, 30000);
    assert.equal(Object.hasOwn(b, 'bufferSize'), false);
  });

  it('supports standalone latencyGuard middleware', async () => {
    const mockClient = new MockClient();
    const tracker = latencyTracker('payments-api');
    const mw = latencyGuard({
      client: mockClient,
      guard: guard(tracker, 150)
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(mockClient.calls[0].guards.length, 1);
  });

  it('fails open on standalone latency-guard availability failures', async () => {
    const timeout = new TimeoutError('request-policy horizon expired');
    const mockClient = {
      checkRateLimit(resources, guards, label, cb) { cb(timeout); }
    };
    const tracker = latencyTracker('payments-api');
    const mw = latencyGuard({
      client: mockClient,
      guard: guard(tracker, 150)
    });
    const { req, res } = createMockReqRes();
    let nextError = 'not called';

    await mw(req, res, (err) => { nextError = err || null; });

    assert.equal(nextError, null);
  });

  it('propagates standalone latency-guard authentication failures', async () => {
    const authError = new AuthenticationError('API key rejected');
    const mockClient = {
      checkRateLimit(resources, guards, label, cb) { cb(authError); }
    };
    const tracker = latencyTracker('payments-api');
    const mw = latencyGuard({
      client: mockClient,
      guard: guard(tracker, 150)
    });
    const { req, res } = createMockReqRes();
    let nextError;

    await mw(req, res, (err) => { nextError = err; });

    assert.equal(nextError, authError);
  });

  it('supports standalone latencyReporter middleware', async () => {
    const mockClient = new MockClient();
    const mw = latencyReporter({
      client: mockClient,
      tracker: latencyTracker('payments-service')
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);

    res.emit('finish');
    assert.equal(mockClient.reports.length, 1);
    assert.equal(mockClient.reports[0][0].latencyTrackerName, 'payments-service');
  });
});
