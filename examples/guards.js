#!/usr/bin/env node
'use strict';

const express = require('express');
const { rateLimitly, latencyTracker, guard } = require('../index');

const app = express();
const PORT = process.env.PORT || 3000;

const databaseLatency = latencyTracker('main_database', {
  ttlMs: '5m',
  maxSamples: 20,
  minSampleThreshold: 5
});

// This is a guard-only request. Granted routes report their measured duration
// afterward, independently of the admission decision.
const databaseProtectedEndpoint = rateLimitly({
  resources: [],
  guards: [
    guard(databaseLatency, 150)
  ],
  reportLatency: databaseLatency,
  onLatencyReportError(error) {
    console.error('[guards example] latency report failed', error);
  },
  failOpen: false,
  standardHeaders: false,
  legacyHeaders: false
});

app.get('/api/search', databaseProtectedEndpoint, async (req, res) => {
  // Simulate database search query
  const query = req.query.q || '';
  await new Promise(resolve => setTimeout(resolve, 200));

  res.json({
    query,
    results: [`Result for ${query}`],
    timestamp: new Date().toISOString()
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Latency Guard RateLimitly Express app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
