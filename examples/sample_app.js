#!/usr/bin/env node
'use strict';

const express = require('express');
const { rateLimitly, resource, latencyTracker, guard } = require('../index');

const authKey = process.env.RATELIMITLY_AUTH_KEY;
if (!authKey) {
  console.error('RATELIMITLY_AUTH_KEY is required.');
  console.error("Example: RATELIMITLY_AUTH_KEY='rl-aes1...' node examples/sample_app.js");
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 8080);

const workLatency = latencyTracker('express_demo_work', {
  ttlMs: '5m',
  maxSamples: 20,
  minSampleThreshold: 5
});

function denialHandler(req, res) {
  res.status(429).json({
    outcome: 'rejected',
    rateLimitly: req.rateLimitly
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Ten tokens per minute are shared by every call to this route.
app.post('/rate-demo', rateLimitly({
  authKey,
  resources: [
    resource('express_demo_requests', '1m', 10, 1)
  ],
  failOpen: false,
  standardHeaders: false,
  legacyHeaders: false,
  handler: denialHandler
}), (req, res) => {
  res.json({ outcome: 'granted' });
});

// This route has no rate resource. It admits through a latency guard and then
// reports the measured route duration to that same fixed latency tracker.
app.post('/latency-demo', rateLimitly({
  authKey,
  resources: [],
  guards: [
    guard(workLatency, 250)
  ],
  reportLatency: workLatency,
  onLatencyReportError(error) {
    console.error('[sample] latency report failed', error);
  },
  failOpen: false,
  standardHeaders: false,
  legacyHeaders: false,
  handler: denialHandler
}), async (req, res) => {
  await new Promise(resolve => setTimeout(resolve, 300));
  res.json({ outcome: 'granted', simulatedWorkMs: 300 });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`RateLimitly Express sample listening on http://localhost:${port}`);
    console.log('POST /rate-demo to exercise resource admission.');
    console.log('POST /latency-demo to exercise a latency guard and report.');
  });
}

module.exports = app;
