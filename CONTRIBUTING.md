# Contributing to rl-express

Thank you for helping improve the official RateLimitly Express middleware.
Code, tests, documentation, examples, and reproducible bug reports are welcome.

Do not open a public issue or pull request for a suspected vulnerability.
Follow the private reporting instructions in [`SECURITY.md`](SECURITY.md).

## Choose a focused change

Keep each pull request limited to one reviewable problem. Open an issue before
investing in a substantial public API, request-policy, compatibility, security,
or behavioral change so its contract and test approach can be agreed first.
Small fixes and documentation corrections may go directly to a pull request.

User-visible behavior changes must update their tests, API guide, examples,
TypeScript declarations where applicable, and changelog entry in the same pull
request. Do not document planned behavior as though it were implemented.

## Prepare a public checkout

Install Node.js 20 or newer and npm, then clone the public repository:

```sh
git clone https://github.com/ratelimitly-com/rl-express.git
cd rl-express
npm ci
```

Create a topic branch from current upstream `main`. Contributors using a fork
should replace `origin` with an `upstream` remote pointing at this repository:

```sh
git fetch origin
git switch -c <short-topic> origin/main
```

Use your own Git identity and email address, or your own GitHub-provided
no-reply address. The project does not assign a shared commit identity.

## Develop and test

Useful focused commands are:

| Change | Focused validation |
| --- | --- |
| Middleware source or tests | `npm run test:unit` |
| UDP/client integration | `npm run test:integration` |
| TypeScript declarations | `npm run test:types` |
| Published package contents or exports | `npm run test:package` |
| JavaScript syntax | `node --check index.js && node --check lib/*.js && node --check examples/*.js` |
| Production dependency audit | `npm audit --omit=dev` |

The public integration suite binds loopback UDP and HTTP sockets. It uses a
synthetic no-auth API key and a deliberately small responder fixture; it
requires no RateLimitly account, production credential, private repository, DNS
service, or live r-server.

Before requesting review, run the complete local gate:

```sh
npm ci
npm test
npm run test:package
npm audit --omit=dev
```

## Preserve the middleware contract

Applications should need only the API exported by `ratelimitly-express` and,
when explicitly configuring the transport layer, the public API of
`ratelimitly-client`. Wire-format, resolver, and socket implementation details
belong to the JavaScript client and should not become competing middleware
contracts.

When changing behavior:

- preserve the distinction between a granted decision, a rejected decision,
  and an operational failure;
- remember that a grant represents resource consumption before the Express
  handler runs and cannot be undone after the response;
- keep resource requests and latency reports independent;
- keep fail-open admission explicit rather than representing it as a grant;
- preserve exact latency-tracker identity across corresponding guards and
  reports;
- keep approximate rate-limit headers disabled by default until they can
  truthfully represent general multi-resource and guarded requests;
- update failure-path coverage, not only successful-path tests;
- use fixed, bounded names and synthetic credentials in examples and tests;
  and
- keep API keys, packet captures, private hostnames, local paths, and customer
  identifiers out of commits, logs, fixtures, issues, and pull requests.

Changes to the pinned `ratelimitly-client` dependency require the public UDP
integration test and the package-consumer test. Keep runtime exports, JSDoc,
TypeScript declarations, examples, and documentation synchronized with the
client version the package actually installs.

## Open a pull request

Review the exact branch before pushing:

```sh
git status --short
git diff --check
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

The pull request should explain:

- the problem and user-visible result;
- important API, compatibility, security, or failure-policy decisions;
- tests run locally;
- documentation and examples changed; and
- the related issue, when one exists.

Every required GitHub Actions job must pass. A green workflow does not replace
review; keep implementation, public documentation, declarations, and tests
synchronized with the final reviewed result.
