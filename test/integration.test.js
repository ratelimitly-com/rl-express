'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const {
  rateLimitly,
  latencyGuard,
  latencyTracker,
  resource,
  guard,
  latencyBlock
} = require('../index');
const { RateLimitResult, ResourceResult, GuardResult } = require('ratelimitly-client');

class MockRClient {
  constructor() {
    this.tokenCounters = new Map();
    this.reports = [];
  }

  checkRateLimit(resources, guards, label, cb) {
    const resourceResults = [];
    let allResourcesPassed = true;

    for (const r of resources) {
      const current = this.tokenCounters.get(r.bucketId) || 0;
      if (current + r.tokensRequested > r.rateLimit) {
        allResourcesPassed = false;
        resourceResults.push(new ResourceResult(r.bucketId, (current + r.tokensRequested) - r.rateLimit, current));
      } else {
        this.tokenCounters.set(r.bucketId, current + r.tokensRequested);
        resourceResults.push(new ResourceResult(r.bucketId, 0, current + r.tokensRequested));
      }
    }

    const guardResults = (guards || []).map(g => {
      const passed = g.thresholdMs >= 100;
      return new GuardResult(g.latencyTrackerName, g.thresholdMs, passed ? 40 : 300, passed);
    });

    const allGuardsPassed = guardResults.every(g => g.passed);
    const success = allResourcesPassed && allGuardsPassed;

    cb(null, new RateLimitResult(success, guardResults, resourceResults, 1n));
  }

  reportLatency(blocks, cb) {
    this.reports.push(blocks);
    if (cb) cb(null);
  }
}

describe('Express HTTP Integration', () => {
  let server;
  let baseUrl;
  let client;

  before(async () => {
    client = new MockRClient();
    const app = express();
    const customerDb = latencyTracker('customer-db');
    const slowDb = latencyTracker('slow-db');

    // 1. Health endpoint (unprotected)
    app.get('/api/demo/health', (req, res) => {
      res.json({ status: 'ok', note: 'ratelimitly express integration' });
    });

    // 2. User route: 3 requests per 10s
    app.get(
      '/api/demo/users/:userId',
      rateLimitly({
        client,
        limit: 3,
        window: '10s',
        bucketId: (req) => `user:${req.params.userId}`,
        message: { error: 'Too Many Requests', message: 'User rate limit exceeded' }
      }),
      (req, res) => {
        res.json({
          userId: req.params.userId,
          message: 'hello from rl-express'
        });
      }
    );

    // 3. Customer route: parameter & query aware
    app.get(
      '/api/demo/customers/:customerId',
      rateLimitly({
        client,
        limit: 2,
        window: '10s',
        bucketId: (req) => `customer:${req.params.customerId}:${req.query.region || 'global'}`,
        guard: guard(customerDb, 250),
        reportLatency: customerDb
      }),
      (req, res) => {
        res.json({
          customerId: req.params.customerId,
          region: req.query.region || 'global',
          status: req.query.status || 'active'
        });
      }
    );

    // 4. Slow route with latency guard
    app.get(
      '/api/demo/slow/:customerId',
      rateLimitly({
        client,
        limit: 5,
        window: '10s',
        bucketId: (req) => `slow:${req.params.customerId}`,
        guard: guard(slowDb, 250),
        reportLatency: slowDb
      }),
      async (req, res) => {
        const start = Date.now();
        await new Promise(r => setTimeout(r, 50));
        res.json({
          customerId: req.params.customerId,
          simulatedLatencyMs: Date.now() - start,
          guardThresholdMs: 250,
          message: 'slow method for latency guard demo'
        });
      }
    );

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('serves health endpoint without rate limiting', async () => {
    const res = await fetch(`${baseUrl}/api/demo/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('enforces route rate limiting and returns 429 when limit is reached', async () => {
    const url = `${baseUrl}/api/demo/users/alice`;

    // 1st request -> allowed; approximate headers are disabled by default.
    const res1 = await fetch(url);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('ratelimit-limit'), null);
    assert.equal(res1.headers.get('ratelimit-remaining'), null);

    // 2nd request -> allowed
    const res2 = await fetch(url);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('ratelimit-remaining'), null);

    // 3rd request -> allowed
    const res3 = await fetch(url);
    assert.equal(res3.status, 200);
    assert.equal(res3.headers.get('ratelimit-remaining'), null);

    // 4th request -> blocked (429)
    const res4 = await fetch(url);
    assert.equal(res4.status, 429);
    assert.equal(res4.headers.get('ratelimit-remaining'), null);
    assert.equal(res4.headers.get('retry-after'), null);
    const body4 = await res4.json();
    assert.equal(body4.error, 'Too Many Requests');

    // Different user 'bob' should not be affected
    const resBob = await fetch(`${baseUrl}/api/demo/users/bob`);
    assert.equal(resBob.status, 200);
  });

  it('handles customer endpoint with query parameters and reports latency', async () => {
    const url = `${baseUrl}/api/demo/customers/cust-1?region=us-east&status=active`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.customerId, 'cust-1');
    assert.equal(body.region, 'us-east');

    // Give a tick for response finish event
    await new Promise(r => setTimeout(r, 20));
    assert.ok(client.reports.length >= 1);
  });

  it('serves slow endpoint and tracks guard', async () => {
    const url = `${baseUrl}/api/demo/slow/cust-100`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.customerId, 'cust-100');
    assert.ok(body.simulatedLatencyMs >= 40);
  });
});
