# Sample application

The sample application demonstrates two independent RateLimitly operations in
an Express server:

- `/rate-demo` makes a resource request for one token; and
- `/latency-demo` makes a guard-only request, serves simulated work when
  granted, and reports the measured route duration afterward.

The identifiers and tracker configuration are fixed by the application. HTTP
clients cannot create arbitrary rate buckets, latency trackers, or reported
latency values.

## Run it

From a clone of this repository:

```bash
npm install
RATELIMITLY_AUTH_KEY='rl-aes1...' node examples/sample_app.js
```

The server listens on port 8080 by default. Set `PORT` to use another port.

## Endpoints

### `GET /health`

Returns HTTP 200 without contacting RateLimitly. The smoke scripts use it to
check that the Express process is ready.

### `POST /rate-demo`

Requests one token from `express_demo_requests`, configured for 10 tokens per
minute. A grant returns HTTP 200; a rejection returns HTTP 429. An availability
failure returns HTTP 503 because the sample sets `failOpen: false`.

```bash
curl -i -X POST http://localhost:8080/rate-demo
```

Run a bounded burst and summarize its outcomes with:

```bash
bash scripts/test-rate-limit.sh
```

### `POST /latency-demo`

Checks that recent latency for `express_demo_work` is below 250 ms. When
granted, the handler performs about 300 ms of simulated work and reports the
measured route duration after sending the response. The tracker requires five
samples before enforcing the guard, so repeated calls demonstrate the
transition from admission to latency-based rejection.

```bash
curl -i -X POST http://localhost:8080/latency-demo
bash scripts/demo-guard.sh
```

The tracker retains at most 20 samples for five minutes. The server also
bounds retained samples by the API key's latency-buffer quota.
