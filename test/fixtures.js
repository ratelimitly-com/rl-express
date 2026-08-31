'use strict';

const { encodeApiKey } = require('ratelimitly-client/api_key_codec');

// Deliberately synthetic: do not reuse a key ID from any deployed API key.
const TEST_KEY_ID = 0x0123456789abcdefn;

const TEST_QUOTAS = Object.freeze({
  rate_buckets_max: 65536,
  latency_services_max: 1024,
  metrics_labels_max: 4096,
  latency_buffer_size_max: 32,
  dedup_ttl_ms_max: 300,
  rate_window_size_ms_max: 0xffffffff
});

/**
 * Builds a valid, authentication-free API key for unit tests.
 *
 * The encoded value is intentionally generated at test runtime so the
 * repository never needs to contain credential material.
 */
function createTestApiKey() {
  return encodeApiKey('none', TEST_KEY_ID, new Uint8Array(0), TEST_QUOTAS);
}

module.exports = {
  TEST_KEY_ID,
  TEST_QUOTAS,
  createTestApiKey
};
