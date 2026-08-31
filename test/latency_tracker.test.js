'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  LatencyTracker,
  latencyTracker,
  rateLimitly,
  latencyGuard,
  latencyReporter,
  guard,
  latencyBlock,
  RateLimitConfigurationError,
  ProtocolError
} = require('../index');
const {
  LatencyGuard,
  ServiceLatencyBlock,
  RateLimitResult
} = require('ratelimitly-client');

function createReqRes() {
  const listeners = new Map();
  const req = { method: 'GET', path: '/orders/123', baseUrl: '/orders' };
  const res = {
    statusCode: 200,
    headersSent: false,
    once(event, listener) {
      const values = listeners.get(event) || [];
      values.push(listener);
      listeners.set(event, values);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    send(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    setHeader() {}
  };
  return { req, res };
}

function grantedResult() {
  return new RateLimitResult(true, [], [], 1n);
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

describe('LatencyTracker contract', () => {
  it('creates one immutable identity shared by guards and reports', () => {
    const tracker = latencyTracker('inventory', {
      ttlMs: '5m',
      maxSamples: 20,
      minSampleThreshold: 5
    });

    assert.ok(tracker instanceof LatencyTracker);
    assert.equal(Object.isFrozen(tracker), true);
    assert.deepEqual({ ...tracker }, {
      latencyTrackerName: 'inventory',
      ttlMs: 300000,
      maxSamples: 20,
      minSampleThreshold: 5
    });

    const latencyGuard = guard(tracker, 200);
    const report = latencyBlock(tracker, 37);

    assert.ok(latencyGuard instanceof LatencyGuard);
    assert.ok(report instanceof ServiceLatencyBlock);
    assert.equal(Object.isFrozen(latencyGuard), true);
    assert.equal(Object.isFrozen(report), true);
    for (const field of ['latencyTrackerName', 'ttlMs', 'maxSamples', 'minSampleThreshold']) {
      assert.equal(latencyGuard[field], report[field]);
      assert.equal(latencyGuard[field], tracker[field]);
    }
    assert.equal(latencyGuard.thresholdMs, 200);
    assert.equal(report.observedLatency, 37);
  });

  it('validates latency-tracker UTF-8 names at both boundaries', () => {
    const exactly255Bytes = `${'é'.repeat(127)}a`;
    assert.equal(Buffer.byteLength(exactly255Bytes, 'utf8'), 255);
    assert.equal(latencyTracker(exactly255Bytes).latencyTrackerName, exactly255Bytes);

    for (const name of ['', '   ', 'é'.repeat(128), 42, null]) {
      assert.throws(
        () => latencyTracker(name),
        error => error instanceof RateLimitConfigurationError
      );
    }
  });

  it('rejects invalid tracker uint32 fields instead of substituting defaults', () => {
    const invalidOptions = [
      { ttlMs: 'soon' },
      { ttlMs: 0 },
      { ttlMs: 0x1_0000_0000 },
      { maxSamples: 0 },
      { maxSamples: 1.5 },
      { maxSamples: 0x1_0000_0000 },
      { minSampleThreshold: -1 },
      { minSampleThreshold: 1.5 },
      { minSampleThreshold: 0x1_0000_0000 }
    ];

    for (const options of invalidOptions) {
      assert.throws(
        () => latencyTracker('inventory', options),
        error => error instanceof RateLimitConfigurationError,
        JSON.stringify(options)
      );
    }

    assert.equal(latencyTracker('inventory', { minSampleThreshold: 0 }).minSampleThreshold, 0);
  });

  it('rejects invalid guard thresholds and reported latencies', () => {
    const tracker = latencyTracker('inventory');
    const invalid = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000, 'later'];

    for (const value of invalid) {
      assert.throws(() => guard(tracker, value), RateLimitConfigurationError);
      assert.throws(() => latencyBlock(tracker, value), RateLimitConfigurationError);
    }

    assert.equal(guard(tracker, 0).thresholdMs, 0);
    assert.equal(latencyBlock(tracker, 0).observedLatency, 0);

    const maximum = latencyTracker('maximum', {
      ttlMs: 0xFFFF_FFFF,
      maxSamples: 0xFFFF_FFFF,
      minSampleThreshold: 0xFFFF_FFFF
    });
    assert.equal(guard(maximum, 0xFFFF_FFFF).thresholdMs, 0xFFFF_FFFF);
    assert.equal(latencyBlock(maximum, 0xFFFF_FFFF).observedLatency, 0xFFFF_FFFF);
  });

  it('does not rewrite maxSamples to the API-key latency-buffer quota', async () => {
    const calls = [];
    const client = {
      quotas: { latency_buffer_size_max: 32 },
      checkRateLimit(resources, guards, label, callback) {
        calls.push(guards);
        callback(null, grantedResult());
      }
    };
    const tracker = latencyTracker('inventory', { maxSamples: 100 });
    const middleware = rateLimitly({ client, guards: [guard(tracker, 200)] });
    const { req, res } = createReqRes();

    await middleware(req, res, () => {});

    assert.equal(calls[0][0].maxSamples, 100);
    assert.equal(tracker.maxSamples, 100);
  });

  it('snapshots static upstream guards and validates them during construction', async () => {
    const calls = [];
    const client = {
      checkRateLimit(resources, guards, label, callback) {
        calls.push(guards);
        callback(null, grantedResult());
      }
    };
    const upstreamGuard = new LatencyGuard({
      latencyTrackerName: 'inventory',
      thresholdMs: 200,
      ttlMs: 300000,
      maxSamples: 20,
      minSampleThreshold: 5
    });
    const middleware = rateLimitly({ client, guards: [upstreamGuard] });
    upstreamGuard.latencyTrackerName = 'mutated';
    upstreamGuard.ttlMs = 1;

    const { req, res } = createReqRes();
    await middleware(req, res, () => {});

    assert.notEqual(calls[0][0], upstreamGuard);
    assert.equal(calls[0][0].latencyTrackerName, 'inventory');
    assert.equal(calls[0][0].ttlMs, 300000);

    assert.throws(
      () => rateLimitly({
        client,
        guards: [new LatencyGuard({
          latencyTrackerName: '',
          thresholdMs: 200,
          ttlMs: 300000,
          maxSamples: 20,
          minSampleThreshold: 5
        })]
      }),
      RateLimitConfigurationError
    );
  });

  it('rejects implicit and legacy static report configuration', () => {
    const client = { checkRateLimit() {}, reportLatency() {} };

    for (const reportLatency of [true, 'inventory', { serviceId: 'inventory' }]) {
      assert.throws(
        () => rateLimitly({ client, reportLatency }),
        RateLimitConfigurationError
      );
    }

    assert.throws(
      () => latencyReporter({ client, report: 'inventory' }),
      RateLimitConfigurationError
    );

    assert.throws(
      () => rateLimitly({
        client: { checkRateLimit() {} },
        reportLatency: latencyTracker('inventory')
      }),
      error => error instanceof RateLimitConfigurationError && /reportLatency/.test(error.message)
    );
  });
});

describe('Latency reporting observability', () => {
  it('measures a uint32 duration for an explicit tracker', async () => {
    const reports = [];
    const client = {
      checkRateLimit() {},
      reportLatency(blocks, callback) {
        reports.push(blocks);
        callback(null);
      }
    };
    const tracker = latencyTracker('inventory');
    const middleware = latencyReporter({ client, tracker });
    const { req, res } = createReqRes();

    middleware(req, res, () => {});
    res.emit('finish');
    await nextTurn();

    assert.equal(reports.length, 1);
    assert.equal(reports[0][0].latencyTrackerName, 'inventory');
    assert.equal(Number.isInteger(reports[0][0].observedLatency), true);
    assert.ok(reports[0][0].observedLatency >= 0);
  });

  it('reports delivery failure exactly once through onLatencyReportError', async () => {
    const expected = new Error('send failed');
    const errors = [];
    const client = {
      checkRateLimit() {},
      reportLatency(blocks, callback) {
        callback(expected);
        throw new Error('client threw after invoking its callback');
      }
    };
    const middleware = latencyReporter({
      client,
      tracker: latencyTracker('inventory'),
      onLatencyReportError(error, req, res) { errors.push({ error, req, res }); }
    });
    const { req, res } = createReqRes();

    middleware(req, res, () => {});
    res.emit('finish');
    res.emit('close');
    await nextTurn();

    assert.equal(errors.length, 1);
    assert.equal(errors[0].error, expected);
    assert.equal(errors[0].req, req);
    assert.equal(errors[0].res, res);
  });

  it('reports invalid dynamic output exactly once', async () => {
    const errors = [];
    const client = {
      checkRateLimit() {},
      reportLatency() { assert.fail('invalid reports must not be sent'); }
    };
    const middleware = latencyReporter({
      client,
      reports() { return [{ latencyTrackerName: '' }]; },
      onLatencyReportError(error) { errors.push(error); }
    });
    const { req, res } = createReqRes();

    middleware(req, res, () => {});
    res.emit('finish');
    res.emit('close');
    await nextTurn();

    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof RateLimitConfigurationError);
  });

  it('snapshots valid upstream blocks returned by a resolver', async () => {
    const upstreamBlock = new ServiceLatencyBlock({
      latencyTrackerName: 'inventory',
      observedLatency: 17,
      ttlMs: 300000,
      maxSamples: 20,
      minSampleThreshold: 5
    });
    const reports = [];
    const client = {
      checkRateLimit() {},
      reportLatency(blocks, callback) {
        reports.push(blocks);
        callback(null);
      }
    };
    const middleware = latencyReporter({ client, reports: () => [upstreamBlock] });
    const { req, res } = createReqRes();

    middleware(req, res, () => {});
    res.emit('finish');
    await nextTurn();

    assert.equal(reports.length, 1);
    assert.notEqual(reports[0][0], upstreamBlock);
    assert.equal(reports[0][0].latencyTrackerName, 'inventory');
    assert.equal(reports[0][0].observedLatency, 17);
    assert.equal(Object.isFrozen(reports[0][0]), true);
  });

  it('wires onLatencyReportError through the main admission middleware', async () => {
    const expected = new Error('send failed');
    const errors = [];
    const client = {
      checkRateLimit(resources, guards, label, callback) {
        callback(null, grantedResult());
      },
      reportLatency(blocks, callback) { callback(expected); }
    };
    const middleware = rateLimitly({
      client,
      reportLatency: latencyTracker('inventory'),
      onLatencyReportError(error) { errors.push(error); }
    });
    const { req, res } = createReqRes();

    await middleware(req, res, () => {});
    res.emit('finish');
    await nextTurn();

    assert.deepEqual(errors, [expected]);
  });

  it('reports a served request admitted by fail-open policy', async () => {
    const reports = [];
    const client = {
      checkRateLimit(resources, guards, label, callback) {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        callback(error);
      },
      reportLatency(blocks, callback) {
        reports.push(blocks);
        callback(null);
      }
    };
    const middleware = rateLimitly({
      client,
      failOpen: true,
      onError() {},
      reportLatency: latencyTracker('inventory')
    });
    const { req, res } = createReqRes();
    let nextCalled = false;

    await middleware(req, res, () => { nextCalled = true; });
    res.emit('finish');
    await nextTurn();

    assert.equal(nextCalled, true);
    assert.equal(req.rateLimitly.outcome, 'fail-open');
    assert.equal(reports.length, 1);
  });

  it('uses a safe default diagnostic when no report error hook is provided', async () => {
    const expected = new Error('send failed');
    const diagnostics = [];
    const original = console.error;
    console.error = (...args) => diagnostics.push(args);
    try {
      const middleware = latencyReporter({
        client: {
          checkRateLimit() {},
          reportLatency(blocks, callback) { callback(expected); }
        },
        tracker: latencyTracker('inventory')
      });
      const { req, res } = createReqRes();
      middleware(req, res, () => {});
      res.emit('finish');
      await nextTurn();
    } finally {
      console.error = original;
    }

    assert.equal(diagnostics.length, 1);
    assert.match(String(diagnostics[0][0]), /latency report failed/i);
    assert.equal(diagnostics[0][1], expected);
  });
});

describe('Standalone latency guard protocol handling', () => {
  it('passes a missing admission decision to Express as ProtocolError', async () => {
    const middleware = latencyGuard({
      client: {
        checkRateLimit(resources, guards, label, callback) { callback(null, null); }
      },
      guards: [guard(latencyTracker('inventory'), 200)]
    });
    const { req, res } = createReqRes();
    let nextError;

    await middleware(req, res, error => { nextError = error; });

    assert.ok(nextError instanceof ProtocolError);
  });
});
