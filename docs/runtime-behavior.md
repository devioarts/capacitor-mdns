# Runtime behavior

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
