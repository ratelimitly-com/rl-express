'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setRateLimitHeaders } = require('../lib/headers');
const { RateLimitResult, ResourceResult } = require('ratelimitly-client');

function createMockRes() {
  const headers = {};
  return {
    setHeader(k, v) {
      headers[k.toLowerCase()] = String(v);
      headers[k] = String(v);
    },
    getHeader(k) {
      return headers[k.toLowerCase()] || headers[k];
    },
    _headers: headers
  };
}

describe('RateLimit headers', () => {
  it('emits no rate-limit headers by default', () => {
    const res = createMockRes();
    const result = new RateLimitResult(true, [], [new ResourceResult('b1', 0, 10)], 1n);

    setRateLimitHeaders(res, {
      options: {},
      result,
      limit: 100,
      windowMs: 60000,
      tokensRequested: 1,
      isAllowed: true
    });

    assert.equal(res.getHeader('RateLimit-Limit'), undefined);
    assert.equal(res.getHeader('X-RateLimit-Limit'), undefined);
  });

  it('does not fabricate headers when explicit resource metadata is unavailable', () => {
    const res = createMockRes();
    const result = new RateLimitResult(true, [], [new ResourceResult('b1', 0, 10)], 1n);

    setRateLimitHeaders(res, {
      options: { standardHeaders: true, legacyHeaders: true },
      result,
      limit: undefined,
      windowMs: undefined,
      tokensRequested: undefined,
      isAllowed: true
    });

    assert.equal(res.getHeader('RateLimit-Limit'), undefined);
    assert.equal(res.getHeader('X-RateLimit-Limit'), undefined);
  });

  it('sets standard RateLimit headers on allow', () => {
    const res = createMockRes();
    const result = new RateLimitResult(true, [], [new ResourceResult('b1', 0, 10)], 1n);

    setRateLimitHeaders(res, {
      options: { standardHeaders: true, legacyHeaders: false },
      result,
      limit: 100,
      windowMs: 60000,
      tokensRequested: 1,
      isAllowed: true
    });

    assert.equal(res.getHeader('RateLimit-Limit'), '100');
    assert.equal(res.getHeader('RateLimit-Remaining'), '90');
    assert.equal(res.getHeader('RateLimit-Reset'), '60');
    assert.equal(res.getHeader('RateLimit-Policy'), '100;w=60');
    assert.equal(res.getHeader('Retry-After'), undefined);
  });

  it('sets Retry-After and zero remaining on deny', () => {
    const res = createMockRes();
    const result = new RateLimitResult(false, [], [new ResourceResult('b1', 5, 100)], 1n);

    setRateLimitHeaders(res, {
      options: { standardHeaders: true, legacyHeaders: false },
      result,
      limit: 100,
      windowMs: 30000,
      tokensRequested: 1,
      isAllowed: false
    });

    assert.equal(res.getHeader('RateLimit-Limit'), '100');
    assert.equal(res.getHeader('RateLimit-Remaining'), '0');
    assert.equal(res.getHeader('RateLimit-Reset'), '30');
    assert.equal(res.getHeader('Retry-After'), '30');
  });

  it('sets legacy X-RateLimit-* headers when enabled', () => {
    const res = createMockRes();
    const result = new RateLimitResult(true, [], [new ResourceResult('b1', 0, 1)], 1n);

    setRateLimitHeaders(res, {
      options: { standardHeaders: false, legacyHeaders: true },
      result,
      limit: 50,
      windowMs: 10000,
      tokensRequested: 1,
      isAllowed: true
    });

    assert.equal(res.getHeader('X-RateLimit-Limit'), '50');
    assert.equal(res.getHeader('X-RateLimit-Remaining'), '49');
    assert.ok(Number(res.getHeader('X-RateLimit-Reset')) > Math.floor(Date.now() / 1000));
    assert.equal(res.getHeader('RateLimit-Limit'), undefined);
  });
});
