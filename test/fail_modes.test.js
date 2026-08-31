'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rateLimitly, resource, RateLimitUnavailableError } = require('../index');
const {
  RateLimitError,
  TimeoutError,
  AuthenticationError,
  ProtocolError
} = require('ratelimitly-client');

class FailingMockClient {
  checkRateLimit(resources, guards, label, cb) {
    process.nextTick(() => {
      cb(new TimeoutError('UDP request timed out after 1000ms'));
    });
  }
}

class ErrorMockClient {
  constructor(error) {
    this.error = error;
  }

  checkRateLimit(resources, guards, label, cb) {
    process.nextTick(() => cb(this.error));
  }
}

const TEST_RESOURCE = resource('failure-mode-test', '1s', 100, 1);

function createMockReqRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(k, v) { headers[k] = v; },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.headersSent = true;
      this.body = body;
      return this;
    }
  };
  const req = {
    method: 'GET',
    url: '/api/demo/users/1',
    ip: '127.0.0.1',
    headers: {}
  };
  return { req, res };
}

describe('Failure and Availability Modes', () => {
  it('fails open by default on RateLimitly network/timeout error', async () => {
    const mockClient = new FailingMockClient();
    let errorLogged = null;

    const mw = rateLimitly({
      client: mockClient,
      resource: TEST_RESOURCE,
      onError: (err) => {
        errorLogged = err;
      }
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.ok(errorLogged instanceof TimeoutError);
    assert.equal(req.rateLimitly.outcome, 'fail-open');
    assert.equal(req.rateLimitly.admitted, true);
    assert.equal('success' in req.rateLimitly, false);
    assert.equal('failOpen' in req.rateLimitly, false);
    assert.ok(req.rateLimitly.error instanceof TimeoutError);
  });

  it('fails closed with 503 when failOpen is false', async () => {
    const mockClient = new FailingMockClient();

    const mw = rateLimitly({
      client: mockClient,
      resource: TEST_RESOURCE,
      failOpen: false
    });

    const { req, res } = createMockReqRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body.error, 'Service Unavailable');
  });

  it('calls custom errorHandler when failOpen is false', async () => {
    const mockClient = new FailingMockClient();
    let customErrorHandlerCalled = false;

    const mw = rateLimitly({
      client: mockClient,
      resource: TEST_RESOURCE,
      failOpen: false,
      errorHandler: (err, req, res, next) => {
        customErrorHandlerCalled = true;
        assert.ok(err instanceof RateLimitUnavailableError);
        res.status(503).json({ custom: 'unavailable' });
      }
    });

    const { req, res } = createMockReqRes();
    await mw(req, res, () => {});

    assert.equal(customErrorHandlerCalled, true);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { custom: 'unavailable' });
  });

  it('fails open on a RateLimitly DNS availability error', async () => {
    const dnsError = new RateLimitError('SRV lookup failed for _ratelimitly._udp.example: ENOTFOUND');
    const mw = rateLimitly({ client: new ErrorMockClient(dnsError), resource: TEST_RESOURCE });
    const { req, res } = createMockReqRes();
    let nextError;

    await mw(req, res, (err) => { nextError = err || null; });

    assert.equal(nextError, null);
    assert.equal(res.statusCode, 200);
    assert.equal(req.rateLimitly.outcome, 'fail-open');
    assert.equal(req.rateLimitly.admitted, true);
  });

  for (const error of [
    new AuthenticationError('API key rejected'),
    new ProtocolError('Malformed response'),
    new Error('unexpected client defect')
  ]) {
    it(`propagates ${error.name} instead of failing open`, async () => {
      const mw = rateLimitly({ client: new ErrorMockClient(error), resource: TEST_RESOURCE });
      const { req, res } = createMockReqRes();
      let nextError;

      await mw(req, res, (err) => { nextError = err; });

      assert.equal(nextError, error);
      assert.equal(res.statusCode, 200);
      assert.equal(req.rateLimitly, undefined);
    });
  }

  it('propagates a missing admission decision as a protocol error', async () => {
    const client = {
      checkRateLimit(resources, guards, label, cb) {
        cb(null, null);
      }
    };
    const mw = rateLimitly({ client, resource: TEST_RESOURCE });
    const { req, res } = createMockReqRes();
    let nextError;

    await mw(req, res, (err) => { nextError = err; });

    assert.ok(nextError instanceof ProtocolError);
    assert.match(nextError.message, /admission decision/i);
    assert.equal(res.statusCode, 200);
    assert.equal(req.rateLimitly, undefined);
  });

  it('propagates resolver exceptions instead of failing open', async () => {
    const resolverError = new Error('resource resolver bug');
    const mw = rateLimitly({
      client: { checkRateLimit() {} },
      resources() { throw resolverError; }
    });
    const { req, res } = createMockReqRes();
    let nextError;

    await mw(req, res, (err) => { nextError = err; });

    assert.equal(nextError, resolverError);
  });

  it('propagates denial-handler exceptions instead of allowing the request', async () => {
    const handlerError = new Error('denial handler bug');
    const client = {
      checkRateLimit(resources, guards, label, cb) {
        cb(null, { success: false, guardResults: [], resourceResults: [] });
      }
    };
    const mw = rateLimitly({
      client,
      resource: TEST_RESOURCE,
      handler() { throw handlerError; }
    });
    const { req, res } = createMockReqRes();
    let nextError;

    await mw(req, res, (err) => { nextError = err; });

    assert.equal(nextError, handlerError);
  });
});
