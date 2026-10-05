# Changelog

## [Unreleased]

### Fixed

- Android: NSD callbacks (delivered on NsdManager's internal thread) are now marshalled to the main thread before touching any state, removing data races between discovery results, the timeout, and publish completion. A publish confirmation racing the publish timeout can no longer complete the call twice.
- Android: before API 34 only one `resolveService` may be active, so concurrent resolves were silently dropped and services lost. Resolves are now queued, retried on `FAILURE_ALREADY_ACTIVE`, and individually timed out.
- Android: stopping or replacing a registration that the OS has not confirmed yet no longer calls `unregisterService` too early; a late confirmation is unregistered when it arrives. `close()` now fails a pending `discover()` instead of leaving it waiting.
- iOS: discovery no longer finishes while a resolver is still outstanding, which could return an empty or partial list when a resolve took longer than the 350 ms settle window.
- iOS: the `NWBrowser` duplicate check used un-normalized type/domain, so every browse update spawned new resolvers for already known services.
- iOS: a denied Local Network permission is now reported as an error instead of an empty discovery result.
- iOS: `txt` values that are not strings are skipped instead of dropping the whole TXT record.

- Electron: a malformed service type (e.g. `http`, `_http._xyz.`) is now rejected with an error instead of being silently advertised/browsed as `_http._tcp.`, matching iOS and Android. An invalid type no longer stops a broadcast that is already running.
- Electron: non-finite `timeout` values (`NaN`, `Infinity`) used to end discovery after ~1 ms; they now fall back to the 3000 ms default, and delays are clamped to the timer maximum.
- Electron: `destroy()` now ends in-flight discoveries (returning partial results flagged as an error) instead of leaving them waiting for their timeout, and a late browser event can no longer mutate an already returned result.

### Changed

- `bonjour-service` is declared as an optional peer dependency (needed by Electron apps only).
- Electron: `new mDNS(bonjour?, options?)` accepts an injectable Bonjour implementation and timeouts for tests.
- Android: NSD access moved behind an internal `NsdBackend` seam (`AndroidNsdBackend` in production) so the logic is unit-testable on the JVM.
- iOS: `MDNS` exposes internal factories and timers for tests.

### Tests

- Added 15 network-free Electron tests (fake Bonjour: type/port validation, publish errors and timeout, filtering, dedup, early exit, timeout handling, destroy).
- Added JVM unit tests for the Android manager (19 cases: callback threading, publish timeout/replace/stop, legacy resolve queue, early exit, close) and XCTest cases for the iOS manager (14 cases). Removed the template placeholder tests.

## [0.1.0]

Compared with `v0.0.3`.

### Added

- Added `getPluginPlatform()` to the public API, returning `ios`, `android`, `electron`, or `web` from the implementation that handled the call.
- Added Capacitor Electron package exports, public Electron type declarations, plugin metadata for `devioarts/capacitor-electron`, and a dedicated Electron build step.
- Added Electron IPC support for `getPluginPlatform()` and kept the manual preload bridge available through `electron/mdns-bridge.cjs`.
- Added an in-repository playground app that exercises broadcast, discovery, Electron bridge usage, logging, and runtime platform detection.
- Added focused docs for platform setup, Electron setup, playground usage, and runtime behavior.
- Added Electron end-to-end tests for publish/discover/stop behavior, platform detection, invalid input handling, and overlapping broadcast calls.
- Added GitHub issue templates, pull request template, CI workflow, Dependabot configuration, and funding metadata.

### Changed

- `startBroadcast()` on iOS, Android, and Electron is now guarded by a publish timeout so native/runtime callbacks cannot leave the JavaScript promise pending forever.
- Starting a new advertisement now stops or replaces the previous active advertisement; the plugin keeps only one active broadcast at a time.
- Discovery sessions are now timeboxed and clean up native listeners, browsers, service-info callbacks, and resolvers more reliably.
- Overlapping discovery calls are serialized or safely isolated from stale callbacks, depending on platform behavior.
- Service type and name inputs are trimmed and normalized consistently across supported platforms.
- Port validation now requires values in the `1..65535` range.
- Android now declares `INTERNET` and `CHANGE_WIFI_MULTICAST_STATE` permissions in the plugin manifest for merge during `npx cap sync`.
- Package exports now expose the root plugin, Electron runtime entry points, Electron settings, the manual bridge, and `package.json`.
- Build, clean, lint, and test scripts now include the Electron runtime and e2e test pipeline.
- README setup and API documentation were regenerated and reorganized around the maintained in-repo playground and docs.

### Fixed

- Fixed web fallback behavior so unsupported browser calls return shaped errors instead of success-like results.
- Fixed pending publish promises when iOS or Android publishing is stopped, replaced, fails, or times out.
- Fixed Android discovery cleanup and listener handling to avoid old callbacks completing a newer request.
- Fixed Android discovery failure reporting so start failures surface through the documented error shape.
- Fixed iOS discovery session handling so stale NWBrowser, NetServiceBrowser, or resolver callbacks cannot complete a newer request.
- Fixed iOS discovery failures to return an error result instead of silently completing as a clean empty search.
- Fixed TXT record normalization on iOS and Electron so discovered values are returned as strings.
- Fixed Electron broadcast stop/destroy handling to avoid orphaned Bonjour advertisers.