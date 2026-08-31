'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dgram = require('node:dgram');

const TLV_TENANT = 0x4C52;
const TLV_AUTH_NONE = 0x414E;
const PDU_RATE_REQUEST = 0x5452;
const PDU_RATE_RESPONSE = 0x5252;
const TENANT_HEADER_SIZE = 40;
const AUTH_NONE_SIZE = 4;
const RATE_PDU_HEADER_SIZE = 12;
const RESOURCE_BLOCK_SIZE = 28;
const RESOURCE_ID_DOMAIN = Buffer.from('ratelimitly.resource.v1\0', 'ascii');

function uint32Le(value) {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32LE(value);
  return encoded;
}

function deriveResourceId(resource) {
  const name = Buffer.from(resource.bucketName, 'utf8');
  return crypto.createHash('blake2s256').update(Buffer.concat([
    RESOURCE_ID_DOMAIN,
    uint32Le(name.length),
    name,
    uint32Le(resource.windowSizeMs),
    uint32Le(resource.rateLimit)
  ])).digest().subarray(0, 16);
}

function parseResourceRequest(packet, expectedKeyId, expectedResource) {
  const expectedPduSize = RATE_PDU_HEADER_SIZE + RESOURCE_BLOCK_SIZE;
  const expectedPacketSize = TENANT_HEADER_SIZE + AUTH_NONE_SIZE + expectedPduSize;
  assert.equal(packet.length, expectedPacketSize, 'unexpected resource-request packet size');

  assert.equal(packet.readUInt16LE(0), TLV_TENANT, 'missing tenant header');
  assert.equal(packet.readUInt16LE(2), TENANT_HEADER_SIZE, 'invalid tenant-header size');
  assert.equal(packet.readBigUInt64LE(4), BigInt(expectedKeyId), 'unexpected API-key ID');
  const requestId = Buffer.from(packet.subarray(12, 28));
  assert.equal(requestId.length, 16);
  assert.notDeepEqual(requestId, Buffer.alloc(16), 'request ID must not be all zeroes');
  assert.equal(packet.readUInt8(37), 0, 'client request must not set the management flag');
  assert.equal(packet.readUInt16LE(38), 0, 'tenant-header padding must be zero');

  assert.equal(packet.readUInt16LE(40), TLV_AUTH_NONE, 'fixture accepts AUTH_NONE only');
  assert.equal(packet.readUInt16LE(42), AUTH_NONE_SIZE, 'invalid AUTH_NONE size');

  const pduOffset = TENANT_HEADER_SIZE + AUTH_NONE_SIZE;
  assert.equal(packet.readUInt16LE(pduOffset), PDU_RATE_REQUEST, 'expected rate-request PDU');
  assert.equal(packet.readUInt16LE(pduOffset + 2), expectedPduSize, 'invalid rate-request PDU size');
  const dedupTtlMs = packet.readUInt32LE(pduOffset + 4);
  const guardCount = packet.readUInt16LE(pduOffset + 8);
  const resourceCount = packet.readUInt16LE(pduOffset + 10);
  assert.ok(dedupTtlMs > 0, 'deduplication TTL must be positive');
  assert.equal(guardCount, 0, 'fixture expects no latency guards');
  assert.equal(resourceCount, 1, 'fixture expects exactly one resource');

  const resourceOffset = pduOffset + RATE_PDU_HEADER_SIZE;
  const resourceId = Buffer.from(packet.subarray(resourceOffset, resourceOffset + 16));
  assert.deepEqual(resourceId, deriveResourceId(expectedResource), 'unexpected canonical resource ID');
  assert.equal(packet.readUInt32LE(resourceOffset + 16), expectedResource.windowSizeMs);
  assert.equal(packet.readUInt32LE(resourceOffset + 20), expectedResource.rateLimit);
  assert.equal(packet.readUInt16LE(resourceOffset + 24), expectedResource.tokensRequested);
  assert.equal(packet.readUInt16LE(resourceOffset + 26), 0, 'resource padding must be zero');

  return {
    requestId,
    dedupTtlMs,
    guardCount,
    resourceCount,
    resourceId
  };
}

function buildRateResponse(request, serverId, decision, expectedResource) {
  const pduSize = RATE_PDU_HEADER_SIZE + RESOURCE_BLOCK_SIZE;
  const packet = Buffer.alloc(TENANT_HEADER_SIZE + AUTH_NONE_SIZE + pduSize);

  packet.writeUInt16LE(TLV_TENANT, 0);
  packet.writeUInt16LE(TENANT_HEADER_SIZE, 2);
  packet.writeBigUInt64LE(BigInt(serverId), 4);
  request.requestId.copy(packet, 12);
  packet.writeBigUInt64LE(BigInt(Date.now()), 28);
  packet.writeUInt8(1, 36); // The current source port may be kept.

  packet.writeUInt16LE(TLV_AUTH_NONE, 40);
  packet.writeUInt16LE(AUTH_NONE_SIZE, 42);

  const pduOffset = TENANT_HEADER_SIZE + AUTH_NONE_SIZE;
  packet.writeUInt16LE(PDU_RATE_RESPONSE, pduOffset);
  packet.writeUInt16LE(pduSize, pduOffset + 2);
  packet.writeUInt16LE(0, pduOffset + 8);
  packet.writeUInt16LE(1, pduOffset + 10);

  const resourceOffset = pduOffset + RATE_PDU_HEADER_SIZE;
  request.resourceId.copy(packet, resourceOffset);
  packet.writeUInt32LE(expectedResource.windowSizeMs, resourceOffset + 16);
  packet.writeUInt32LE(expectedResource.rateLimit, resourceOffset + 20);
  packet.writeUInt16LE(decision === 'grant' ? 0 : 1, resourceOffset + 24);

  return packet;
}

class SyntheticRateLimitlyResponder {
  constructor({ expectedKeyId, expectedResource, decisions, serverId = 1 }) {
    this.expectedKeyId = expectedKeyId;
    this.expectedResource = expectedResource;
    this.decisions = [...decisions];
    this.serverId = serverId;
    this.requests = [];
    this.failure = null;
    this.socket = null;
  }

  get port() {
    return this.socket.address().port;
  }

  async listen() {
    assert.equal(this.socket, null, 'synthetic responder is already listening');
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (packet, remote) => this.#handleMessage(packet, remote));
    this.socket.on('error', (error) => {
      this.failure ||= error;
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.socket.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.off('error', onError);
        resolve();
      };
      this.socket.once('error', onError);
      this.socket.once('listening', onListening);
      this.socket.bind(0, '127.0.0.1');
    });
  }

  #handleMessage(packet, remote) {
    try {
      const decision = this.decisions.shift();
      assert.ok(decision, 'received more requests than the test configured');
      assert.ok(decision === 'grant' || decision === 'reject', 'invalid synthetic decision');
      const request = parseResourceRequest(packet, this.expectedKeyId, this.expectedResource);
      this.requests.push(request);
      const response = buildRateResponse(request, this.serverId, decision, this.expectedResource);
      this.socket.send(response, remote.port, remote.address, (error) => {
        if (error) this.failure ||= error;
      });
    } catch (error) {
      this.failure ||= error;
    }
  }

  async close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    await new Promise((resolve) => socket.close(resolve));
  }
}

module.exports = {
  SyntheticRateLimitlyResponder
};
