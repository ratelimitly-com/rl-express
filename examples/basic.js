#!/usr/bin/env node
'use strict';

const express = require('express');
const { rateLimitly, resource } = require('../index');

const app = express();
const PORT = process.env.PORT || 3000;

// Apply one fixed application-wide rate: 100 requests per 15 minutes.
app.use(
  rateLimitly({
    resources: [
      resource('basic_api_requests', '15m', 100, 1)
    ],
    failOpen: false,
    standardHeaders: false,
    legacyHeaders: false,
    message: {
      status: 429,
      error: 'Too Many Requests',
      message: 'The application-wide request rate has been exceeded.'
    }
  })
);

app.get('/', (req, res) => {
  res.send('Hello from RateLimitly Express!');
});

app.get('/api/data', (req, res) => {
  res.json({
    data: 'Protected data',
    admission: req.rateLimitly
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Basic RateLimitly Express app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
