# API guide

This guide documents the Express integration surface. The underlying wire
protocol, DNS discovery, retries, server ordering, and high-availability policy
belong to
[`ratelimitly-client`](https://github.com/ratelimitly-com/rl-js-client).

## Creating middleware

The default export and the named `rateLimitly` export are the same middleware
factory:

```javascript
const rateLimitly = require('ratelimitly-express');
// or:
const { rateLimitly } = require('ratelimitly-express');
```

The middleware needs either:

- `authKey`, or `RATELIMITLY_AUTH_KEY` in the environment; or
- an initialized `ratelimitly-client` instance supplied as `client`.

When an API key is supplied, the client derives the RateLimitly DNS name from
the key. `dnsName` overrides that derived name. Direct server lists are not
part of the documented Express middleware API.

When the middleware constructs the client, `requestPolicy` configures its HA
request schedule and `dnsRefreshIntervalS` configures DNS membership refresh.
Shared middleware instances reuse a client only when the API-key configuration
and every effective request-policy field are identical.

For one explicit client lifecycle shared across middleware instances, construct
the JavaScript client and pass it to each middleware instance:

```javascript
const { createClient, RequestPolicy } = require('ratelimitly-client');
const { rateLimitly, resource } = require('ratelimitly-express');

const client = createClient(process.env.RATELIMITLY_AUTH_KEY, null, {
  requestPolicy: new RequestPolicy({ unitMs: 25, replayCount: 3 })
});

app.post('/work', rateLimitly({
  client,
  resources: [resource('work', '1s', 100, 1)]
}), handler);
```

Consult the JavaScript client documentation for its current constructor and
policy parameters. Older settings named `clientOptions`, `timeoutMs`,
`retryAttempts`, `dedupTtlMs`, and `serverStabilityThresholdMs` are not valid
middleware configuration. The 2.x client derives request timing and the
deduplication horizon from `RequestPolicy`; `ratelimitly-express` rejects those
removed names rather than silently ignoring them.

## Resource requests

Use `resources` and `guards` to describe the complete admission request. Each
option accepts an array or a function `(req, res) => array`; the function may be
asynchronous.

```javascript
const inventoryLatency = latencyTracker('inventory', {
  ttlMs: '5m',
  maxSamples: 20,
  minSampleThreshold: 5
});

rateLimitly({
  resources: (req, res) => [
    resource('checkout', '1s', 100, 1),
    resource('expensive_operation', '1m', 20, 1)
  ],
  guards: [
    guard(inventoryLatency, 200)
  ]
});
```

An empty resource list is valid. It creates a guard-only request:

```javascript
rateLimitly({
  resources: [],
  guards: [guard(latencyTracker('inventory'), 200)]
});
```

An empty resource and guard list is also valid and succeeds without sending a
RateLimitly request.

### Resource helper

```javascript
resource(bucketId, window, rate, tokensRequested)
```

- `bucketId` is the stable, content-defined name of the rate counter.
- `window` is a duration in milliseconds or a string such as `'1s'`, `'1m'`,
  or `'1h'`.
- `rate` is the number of tokens available per window.
- `tokensRequested` is the quantity requested by this admission request.

Clients in different languages must use the same semantic inputs for the same
resource. Avoid unbounded user-controlled bucket names: every distinct name
creates distinct server-side state.

### Latency tracker and guard helpers

```javascript
const tracker = latencyTracker(latencyTrackerName, options);
const latencyGuard = guard(tracker, thresholdMs);
```

- `latencyTrackerName` is an explicit stable name of at most 255 UTF-8 bytes.
- `options` may contain `ttlMs`, `maxSamples`, and `minSampleThreshold`; their
  defaults are 5 minutes, 100, and 8.
- `thresholdMs` is the largest acceptable recent latency.

The tracker is immutable. Its name, TTL, maximum sample count, and minimum
sample threshold jointly define its canonical identity. Reuse the same tracker
object when constructing corresponding guards and reports. The guard threshold
and each observed latency are operation values and do not affect identity.

Every wire field is checked as a `uint32`. TTL and `maxSamples` must be
positive; `minSampleThreshold`, guard threshold, and observed latency may be
zero. Duration strings require an explicit unit such as `ms`, `s`, `m`, `h`,
or `d`. Invalid values are rejected rather than replaced by defaults.

There is no `bufferSize` setting in the current client API or wire protocol.
`maxSamples` is request-defined and remains part of tracker identity even when
it exceeds the API-key buffer quota. The server retains at most
`min(latency_buffer_size_max, maxSamples)` samples; the middleware never
silently rewrites `maxSamples`.

### Convenience single-resource options

The convenience form constructs exactly one resource without calling the
`resource()` helper. It still requires the application to state the resource
identity, window, and rate explicitly:

```javascript
rateLimitly({
  bucketId: 'checkout',
  window: '1s',
  limit: 100,
  tokens: 1
});
```

`bucketId` may be a function when the server resource genuinely depends on
request data. Per-user or per-client-address partitioning is opt-in through a
`bucketId` function or `keyGenerator`; the middleware never creates an IP
bucket by default.

```javascript
const { defaultKeyGenerator } = require('ratelimitly-express');

rateLimitly({
  keyGenerator: defaultKeyGenerator,
  prefix: 'checkout-client:',
  window: '1s',
  limit: 5
});
```

Supplying only some convenience fields is a configuration error. Do not mix
the convenience fields with `resource` or `resources`; explicit resource
objects are recommended for new integrations.

When no resource configuration is present, no resource tokens are requested.
Guards then form a genuine guard-only request. With neither resources nor
guards, the client resolves the empty logical request locally as a grant; no
UDP request is sent. The middleware records that successful result and calls
`next()`. An independently configured latency report may still be sent after
the response finishes.

## Admission outcomes

On grant, the middleware stores `outcome: 'granted'` and `admitted: true` on
`req.rateLimitly`, then calls `next()`.

On rejection, it stores `outcome: 'rejected'` and `admitted: false`, then
responds with HTTP 429 by default. Customize this with:

- `statusCode`;
- `message`; or
- `handler(req, res, next, options, result)`.

On transport, DNS, or timeout failure:

- `failOpen: true` calls `next()` and records `outcome: 'fail-open'` with
  `admitted: true`; or
- `failOpen: false` responds with HTTP 503, using `errorHandler` when one is
  provided.

Configuration, authentication, protocol, and application-hook errors are
passed to Express error handling. `failOpen` does not turn those errors into
grants.

`skip(req, res)` may bypass the admission request. It may be asynchronous and
is evaluated before any RateLimitly request. Post-response options such as
`skipSuccessfulRequests`, `skipFailedRequests`, and `requestWasSuccessful` are
rejected: once RateLimitly grants a request, the corresponding resource
consumption has already occurred and an HTTP response cannot undo it.

## Latency reports

`latencyReporter(options)` measures the time from middleware entry until the
HTTP response finishes and then reports that duration asynchronously:

```javascript
const { latencyReporter, latencyTracker } = require('ratelimitly-express');

const inventoryLatency = latencyTracker('inventory', {
  ttlMs: '5m',
  maxSamples: 20,
  minSampleThreshold: 5
});

app.use('/inventory', latencyReporter({
  tracker: inventoryLatency,
  onLatencyReportError(error, req, res) {
    console.error('RateLimitly latency report failed', error);
  }
}));
```

The main middleware accepts the same tracker through `reportLatency`:

```javascript
rateLimitly({
  resources: [resource('inventory_reads', '1s', 100, 1)],
  guards: [guard(inventoryLatency, 200)],
  reportLatency: inventoryLatency,
  onLatencyReportError(error, req, res) {
    console.error('RateLimitly latency report failed', error);
  }
});
```

`reportLatency` may be one tracker, an array of trackers, or a function
receiving `(req, res, durationMs)` and returning an array of reports made with
`latencyBlock(tracker, observedLatency)`. The standalone reporter uses exactly
one of `tracker`, `trackers`, or `reports` for the same three forms.

The measured duration is rounded upward to a `uint32` millisecond value.
`reportLatency: true`, strings, and inline tracker objects are rejected. This
prevents route paths or request values from creating accidental, unbounded
server-side tracker state.

Use fixed, bounded tracker names. Do not let arbitrary request input define
tracker names, tracker sizes, TTLs, or measured latency values. A latency report
should normally use the duration observed by the middleware.

Latency reports are independent of resource requests. A reporting middleware
does not guard or consume resources, and a guard can inspect reports produced
by a different process.

Reports are fire-and-forget with respect to the HTTP response. Local resolver,
validation, and send failures call `onLatencyReportError(error, req, res)` once.
Without that hook the middleware writes one safe diagnostic to `console.error`;
it never includes API-key material.

The combined `rateLimitly` middleware reports only requests that continue to
the Express handler: granted requests and requests admitted by `failOpen`.
Rejected requests are not served and therefore are not reported. A request
bypassed by `skip` bypasses reporting as well.

## Request context

After a grant, rejection, or fail-open admission, `req.rateLimitly` contains an
explicit `outcome` and `admitted` value. A fail-open admission is deliberately
not represented as a RateLimitly grant because no server decision was
received. Its client response fields otherwise depend on `ratelimitly-client`.
A request bypassed by `skip` has no RateLimitly outcome.

## Response headers

`standardHeaders` and `legacyHeaders` provide compatibility with conventional
single-rate-limit middleware. Their `limit`, `remaining`, and reset values
cannot faithfully represent a general atomic request containing multiple
resources or latency guards.

Both options default to `false`. They may be enabled explicitly for a
conventional single-resource integration, but their current values are an
approximation and are not authoritative for general RateLimitly requests.
Designing truthful headers is tracked in
[`rl-express#1`](https://github.com/ratelimitly-com/rl-express/issues/1).
Treat the admission status and `req.rateLimitly` as authoritative.

## Client ownership and shutdown

Middleware created from the same API-key configuration may share a cached
client. Supplying `client` gives the application explicit ownership and is the
recommended choice when deterministic shutdown is required.

The exported `closeSharedClients()` helper destroys every middleware-managed
cached client and clears the cache. Call it during graceful application
shutdown. Destruction errors are collected and reported as an `AggregateError`
after every cached client has been attempted.

The helper never destroys a client supplied through `client`; that client is
application-owned and the application must call its `destroy()` method.

## TypeScript

The package includes declarations in `index.d.ts` for middleware options,
helpers, request context, and Express request augmentation. Client classes such
as `RClient`, `RequestPolicy`, `ResourceRequest`, and `LatencyGuard` are direct
runtime and type re-exports from `ratelimitly-client`; this package does not
maintain competing copies of their contracts.

The repository compiles one small strict consumer covering a resource request,
a shared latency tracker, a guard, post-response reporting, and response
metadata. This is a declaration drift check, not a separate TypeScript API.
