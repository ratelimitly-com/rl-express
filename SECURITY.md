# Security Policy

## Report privately

Do not open a public issue or pull request for a suspected vulnerability.
Submit it through GitHub's private vulnerability reporting for this repository:

[Open a private security report](https://github.com/ratelimitly-com/rl-express/security/advisories/new)

The report is private to the repository's security maintainers and requires a
GitHub account. GitHub private reporting is the authoritative security contact
for `rl-express`; this project does not advertise an unverified email alias.

Report vulnerabilities in the Express middleware, its published npm package,
client ownership and caching, admission or failure-policy handling, latency
reporting, CI, or release tooling here. If the root cause belongs to
[`ratelimitly-client`](https://github.com/ratelimitly-com/rl-js-client), Express,
or another dependency, report it to that project as well and explain the
middleware impact in this private report.

Test only applications, infrastructure, and API keys you own or are explicitly
authorized to test. The local synthetic UDP responder is the preferred
wire-level reproduction environment.

## What to include

Include enough detail for a maintainer to reproduce and assess the report:

- affected commit, npm package version, or tag;
- Node.js and Express versions, operating system, and architecture;
- relevant middleware configuration and proxy topology;
- minimal reproduction steps and the expected and observed behavior;
- the security impact and required attacker position or preconditions; and
- a proposed mitigation or patch, if available.

Remove API keys, authentication material, customer identifiers, private
hostnames, personal data, and unrelated application data from logs, traces,
configurations, and packet captures. A synthetic fixture reproducer is more
useful than a production capture.

## Supported versions

Security fixes target the latest published release, when one exists, and
current `main` unless release notes explicitly extend support to an older line.
Users of older releases should expect to upgrade. Private pre-public tags are
not supported release lines. The supported Node.js and Express versions are
declared in `package.json`, CI, and the release notes.

## Response and coordinated disclosure

Maintainers aim to acknowledge a private report within three business days,
provide an initial impact assessment within seven business days, and post an
update at least every fourteen calendar days while investigation continues.
These are response targets, not a guarantee that a fix can be produced within a
fixed time.

For a confirmed issue, maintainers will coordinate remediation, supported
version impact, release timing, and public disclosure with the reporter. A
GitHub Security Advisory and CVE request may be used when appropriate. Do not
publish technical details or proof-of-concept code before the agreed disclosure
date. Reporter credit is given only with permission.

## Deployment and credential safety

Treat every RateLimitly API key as a credential. Never commit or publish a real
key in source, examples, issues, pull requests, CI logs, process arguments,
error output, test artifacts, or packet captures. Supply credentials through an
environment variable or secret manager and rotate any key that is exposed.

An operational failure is not a RateLimitly grant. Enabling `failOpen` is an
explicit availability decision that allows an HTTP request to continue without
a server decision; evaluate that tradeoff for every protected route.

IP-based bucket partitioning is opt-in. If an application uses
`defaultKeyGenerator`, configure Express `trust proxy` for the exact trusted
proxy topology so `req.ip` cannot be influenced by an untrusted forwarding
header. Prefer stable application identities when they better represent the
resource being limited.

Use fixed, bounded resource and latency-tracker names. Do not derive them from
unbounded request input, customer data, secrets, or full URLs. Every distinct
name can create distinct server-side state and may expose sensitive labels.
