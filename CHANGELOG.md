# Changelog

All notable changes to `ratelimitly-express` will be documented in this file.
The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-09-01

### Added

- Express admission middleware for atomic resource requests and latency guards.
- Explicit granted, rejected, operational-failure, and fail-open outcomes.
- Resource, latency-tracker, guard, and latency-report helpers with strict input
  validation and canonical client-defined identities.
- Standalone and post-response latency reporting with an explicit error hook.
- Shared middleware-managed clients, application-owned client injection, and
  deterministic shared-client shutdown.
- Configurable JavaScript-client high-availability request policy and DNS
  refresh behavior.
- Focused CommonJS exports and TypeScript declarations for the public
  middleware surface.
- Credential-free public UDP integration tests and packed-package consumer
  validation.

### Changed

- Use `ratelimitly-client` 2.0.0 and the current wire format without a latency
  `bufferSize` field.
- Require explicit, stable latency trackers for corresponding guards and
  reports; implicit route-derived tracker identities are rejected.
- Keep approximate conventional HTTP rate-limit headers disabled by default.

[Unreleased]: https://github.com/ratelimitly-com/rl-express/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ratelimitly-com/rl-express/releases/tag/v1.0.0
