# Runtime behavior

## Continuous discovery

- `watchServices({ types })` is available on iOS, Android and Electron. A nonempty array of valid
  `_name._tcp.` / `_name._udp.` types is required. Types are trimmed, trailing dots appended and
  duplicates merged. Invalid input leaves the current watch running.
- One watch group is active. A valid replacement first stops the old group. `watchersStarted`
  counts requested native browsers; asynchronous startup failures arrive through `watchError`.
- Register `serviceFound`, `serviceLost` and `watchError` listeners before starting. Found/lost
  contain `{ service }` with `name`, full `type`, `domain`, `port`, `hosts` and optional `txt` /
  `hostname`. `hosts` is always an array. Lost uses the last resolved snapshot, and is emitted
  only if the service was reported as found. A disappearance during resolve cancels that candidate.
- Each service emits found once per period of presence. Lost carries the last resolved snapshot;
  this API does not promise continuous updates or separate events for address or TXT changes.
- A browser / transport failure stops the watch group and emits `{ type, errorMessage,
  watching: false }`. Native resolve errors retry up to three times, then emit the same event with
  `watching: true`; a later discovery can retry that service again.
- `stopWatching()` returns `{ watching: false, error, errorMessage }`, suppresses old callbacks and
  cancels browsers, pending resolves and retries. Stop failures are reported and cleanup can be
  retried. It does not stop an advertisement or one-shot discovery. Native manager destruction
  also closes the watch group.
- Android watch groups and one-shot discovery share the pre-API-34 resolver queue and hold separate
  references to the Wi-Fi multicast lock. Resolved NSD TXT attributes are returned as UTF-8 strings.
- Electron observes Bonjour goodbye packets and PTR TTL expiry. It refreshes browse queries every
  30 seconds and checks expiry every second. Detection after abrupt network loss depends on the
  peer's advertised TTL. Late address packets update the cached snapshot.
- A regular web browser returns `error: true` for watch startup; stop is an idempotent no-op.
  The manual Electron preload bridge forwards all three event types and supports listener removal.

## One-shot discovery and advertising

- All methods resolve with the documented result shape. Runtime failures are reported through
  `error` and `errorMessage` instead of rejecting when the platform bridge can recover safely.
- `getPluginPlatform()` resolves to `ios`, `android`, `electron`, or `web` from the implementation
  that handled the call.
- `startBroadcast()` is guarded by a native timeout on Android, iOS, and Electron. If the OS does
  not report publish success or failure, the operation is stopped and returned as an error.
- Only one advertisement is active at a time. Starting a new advertisement stops the previous one.
- Discovery is timeboxed and cleans up native listeners, browsers, service-info callbacks, and
  resolvers after completion. Overlapping discovery calls are serialized or safely replace the
  previous native session so stale callbacks cannot complete a newer request.
- `stopBroadcast()` is idempotent and safe to call repeatedly, including after failed or timed-out
  publish attempts.
- Android and Electron wait for stop confirmation. A failed or timed-out stop returns `error: true`
  and `publishing: true` because the service may still be active. The registration is retained for
  cleanup, and a replacement advertisement is not started until stopping succeeds.
- On Android versions before T extension 7, mDNS operations hold a reference-counted Wi-Fi
  multicast lock. Overlapping publishing and discovery keep separate references, so completing
  discovery does not disable multicast for the active advertisement. Failed publish/stop attempts
  release their lock reference while retaining any registration needed for late cleanup.
- iOS always returns `hosts` as an array, including when no address was resolved. IPv6 addresses
  with an interface scope retain it as a `%<scope-id>` suffix.
- On iOS a denied Local Network permission makes `discover()` report an error instead of returning an
  empty list after the timeout.
- Android resolves discovered services one at a time before API 34 (a platform limit of
  `NsdManager.resolveService`); on API 34+ resolves run concurrently.
- A service `type` must look like `_name._tcp.` or `_name._udp.` (trailing dot optional). Electron
  rejects anything else with an error; it never falls back to another type.
