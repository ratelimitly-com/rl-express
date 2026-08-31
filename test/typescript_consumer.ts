import type { RequestHandler } from 'express';
import rateLimitly, {
  AuthMethod,
  RequestPolicy,
  guard,
  latencyTracker,
  resource
} from '..';

const inventoryLatency = latencyTracker('inventory', {
  ttlMs: '5m',
  maxSamples: 20,
  minSampleThreshold: 5
});

const inventoryRead = resource('inventory_reads', '1s', 100, 1);

// The fields below come directly from ratelimitly-client declarations. This
// catches drift without copying those class declarations into rl-express.
inventoryRead.bucketName.toUpperCase();
guard(inventoryLatency, 200).latencyTrackerName.toUpperCase();
AuthMethod.AES_GCM.toUpperCase();

const policy = new RequestPolicy({ unitMs: 25, replayCount: 3 });

const middleware: RequestHandler = rateLimitly({
  authKey: 'rl-aes1-example-not-executed',
  requestPolicy: policy,
  resources: [inventoryRead],
  guards: [guard(inventoryLatency, 200)],
  reportLatency: inventoryLatency,
  failOpen: false,
  onLimitReached(req, res, options, result) {
    result.requestId?.toUpperCase();
    result.steeringFeedback.valueOf();
  },
  onLatencyReportError(error, req) {
    console.error(error.message, req.rateLimitly?.outcome);
  }
});

void middleware;
