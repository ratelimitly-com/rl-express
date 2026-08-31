'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  AuthMethod,
  RClient,
  RClientConfig,
  RequestPolicy,
  TenantConfig,
  rateLimitly,
  resource
} = require('../index');
const { TEST_KEY_ID, createTestApiKey } = require('./fixtures');
const { SyntheticRateLimitlyResponder } = require('./synthetic_responder');

async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('public wire-level Express integration', () => {
  it('maps real UDP grant and rejection responses to HTTP behavior', async () => {
    const expectedResource = resource('wire-contract', '10s', 1, 1);
    const responder = new SyntheticRateLimitlyResponder({
      expectedKeyId: TEST_KEY_ID,
      expectedResource,
      decisions: ['grant', 'reject']
    });
    let client;
    let httpServer;
    let baseUrl;

    try {
      await responder.listen();

      const tenant = new TenantConfig(
        'synthetic.invalid',
        TEST_KEY_ID,
        AuthMethod.NONE,
        createTestApiKey()
      );
      client = new RClient(new RClientConfig(tenant, {
        requestPolicy: new RequestPolicy({
          unitMs: 125,
          replayCount: 0,
          finalReceiveUnits: 1,
          completionDelivery: false
        })
      }));
      client.servers = [{
        ip: '127.0.0.1',
        port: responder.port,
        serverId: responder.serverId
      }];
      client.lastDnsRefresh = Date.now();

      let routeExecutions = 0;
      const app = express();
      app.get(
        '/protected',
        rateLimitly({
          client,
          resources: [expectedResource],
          failOpen: false
        }),
        (req, res) => {
          routeExecutions += 1;
          res.json({ outcome: req.rateLimitly.outcome });
        }
      );

      ({ server: httpServer, baseUrl } = await listen(app));

      const granted = await fetch(`${baseUrl}/protected`);
      assert.ifError(responder.failure);
      assert.equal(granted.status, 200);
      assert.deepEqual(await granted.json(), { outcome: 'granted' });
      assert.equal(routeExecutions, 1);

      const rejected = await fetch(`${baseUrl}/protected`);
      assert.ifError(responder.failure);
      assert.equal(rejected.status, 429);
      assert.equal(routeExecutions, 1, 'a rejected request must not run the route');

      assert.equal(responder.requests.length, 2);
      assert.equal(responder.requests[0].dedupTtlMs, 250);
      assert.equal(responder.requests[0].guardCount, 0);
      assert.equal(responder.requests[0].resourceCount, 1);
      assert.equal(responder.requests[1].requestId.equals(responder.requests[0].requestId), false);
    } finally {
      await closeServer(httpServer);
      if (client) client.destroy();
      await responder.close();
    }
  });
});
