# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-07-07

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

### Notes

- The web fallback behavior is intentionally stricter: unsupported `startBroadcast()` and `discover()` now resolve with `error: true`.
- Electron applications using `devioarts/capacitor-electron` should import plugin metadata from `@devioarts/capacitor-mdns/electron/settings`.

[0.1.0]: https://github.com/devioarts/capacitor-mdns/compare/v0.0.3...v0.1.0
