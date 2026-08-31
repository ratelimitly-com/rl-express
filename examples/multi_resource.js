#!/usr/bin/env node
'use strict';

const express = require('express');
const { rateLimitly, resource } = require('../index');

const app = express();
const PORT = process.env.PORT || 3000;

// Evaluate two fixed resources atomically. If either condition is not
// satisfied, neither resource consumes tokens.
const checkoutLimiter = rateLimitly({
  resources: [
    resource('checkout_requests', '1s', 1000, 1),
    resource('payment_provider_requests', '1s', 100, 1)
  ],
  label: 'api.checkout.order',
  failOpen: false,
  standardHeaders: false,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Checkout rate limit reached. Please wait before placing another order.'
  }
});

app.post('/api/checkout', checkoutLimiter, (req, res) => {
  res.json({
    status: 'order_processed',
    timestamp: new Date().toISOString()
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Multi-resource RateLimitly Express app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
