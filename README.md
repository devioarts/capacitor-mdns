# @devioarts/capacitor-mdns

mDNS plugin for Capacitor that supports Bonjour/mDNS advertisements and discovery on iOS,
Android, Electron, and a safe web fallback.

**Supported Capacitor version: v8.**

#### Supported platforms: &#x2713; iOS &#x2713; Android &#x2713; Electron &#x2713; Web fallback

The in-repository [`playground`](./playground) is the example app used during development.

## Install

```bash
npm install @devioarts/capacitor-mdns
npx cap sync
```

## Usage

```ts
import { mDNS } from '@devioarts/capacitor-mdns';

const runtime = await mDNS.getPluginPlatform();

await mDNS.startBroadcast({ type: '_http._tcp.', name: 'MyService', port: 9100 });
const result = await mDNS.discover({ type: '_http._tcp.', timeout: 3000 });
await mDNS.stopBroadcast();
```

## Continuous discovery

Thank you, [Idrimi](https://github.com/Idrimi), for contributing the original continuous discovery
feature in [PR #7](https://github.com/devioarts/capacitor-mdns/pull/7).

`watchServices()` monitors multiple service types on iOS, Android and Electron until stopped.
Register listeners before starting; a new valid call replaces the previous watch.

```ts
const found = await mDNS.addListener('serviceFound', ({ service }) => {
  console.log('Found', service.name, service.hosts, service.port);
});
const lost = await mDNS.addListener('serviceLost', ({ service }) => {
  console.log('Lost', service.name, service.hosts, service.port);
});
const errors = await mDNS.addListener('watchError', (event) => {
  console.error(event.type, event.errorMessage, event.watching);
});

const result = await mDNS.watchServices({
  types: ['_http._tcp.', '_airplay._tcp.', '_googlecast._tcp.'],
});
// Later, including when leaving the screen:
await mDNS.stopWatching();
await Promise.all([found.remove(), lost.remove(), errors.remove()]);
```

Found/lost events contain the full service snapshot; `hosts` is always an array. A service
that disappears before resolving emits neither event. Browser errors stop watching and emit
`watchError` with `watching: false`; exhausted resolution retries emit it with `watching: true`.
`stopWatching()` leaves broadcasting and one-shot discovery running. Browsers do not support mDNS.

## Platform Setup


Android requires mDNS/network permissions in `AndroidManifest.xml`; the plugin also declares them
so they are merged during sync. iOS requires local network keys in `Info.plist`.
Electron support is intended for [`devioarts/capacitor-electron`](https://github.com/devioarts/capacitor-electron)
and uses metadata exported from `@devioarts/capacitor-mdns/electron/settings`.

Detailed setup lives in:

- [iOS and Android setup](./docs/platform-setup.md)
- [Electron setup](./docs/electron.md)
- [Playground](./docs/playground.md)
- [Runtime behavior](./docs/runtime-behavior.md)

## API

<docgen-index>

* [`getPluginPlatform()`](#getpluginplatform)
* [`startBroadcast(...)`](#startbroadcast)
* [`stopBroadcast()`](#stopbroadcast)
* [`discover(...)`](#discover)
* [`watchServices(...)`](#watchservices)
* [`stopWatching()`](#stopwatching)
* [`addListener('serviceFound' | 'serviceLost', ...)`](#addlistenerservicefound--servicelost-)
* [`addListener('watchError', ...)`](#addlistenerwatcherror-)
* [`removeAllListeners()`](#removealllisteners)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

Public API surface of the Capacitor mDNS plugin.

### getPluginPlatform()

```typescript
getPluginPlatform() => Promise<MdnsPluginPlatformResult>
```

Return the platform implementation currently serving plugin calls.

**Returns:** <code>Promise&lt;<a href="#mdnspluginplatformresult">MdnsPluginPlatformResult</a>&gt;</code>

--------------------


### startBroadcast(...)

```typescript
startBroadcast(options: MdnsBroadcastOptions) => Promise<MdnsBroadcastResult>
```

Start advertising a Bonjour/mDNS service.

| Param         | Type                                                                  | Description                                                        |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **`options`** | <code><a href="#mdnsbroadcastoptions">MdnsBroadcastOptions</a></code> | - {@link <a href="#mdnsbroadcastoptions">MdnsBroadcastOptions</a>} |

**Returns:** <code>Promise&lt;<a href="#mdnsbroadcastresult">MdnsBroadcastResult</a>&gt;</code>

--------------------


### stopBroadcast()

```typescript
stopBroadcast() => Promise<MdnsStopResult>
```

Stop advertising the currently registered service (no-op if none).

**Returns:** <code>Promise&lt;<a href="#mdnsstopresult">MdnsStopResult</a>&gt;</code>

--------------------


### discover(...)

```typescript
discover(options?: MdnsDiscoverOptions | undefined) => Promise<MdnsDiscoverResult>
```

Discover services of a given type and optionally filter by instance name.

| Param         | Type                                                                | Description                                                      |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **`options`** | <code><a href="#mdnsdiscoveroptions">MdnsDiscoverOptions</a></code> | - {@link <a href="#mdnsdiscoveroptions">MdnsDiscoverOptions</a>} |

**Returns:** <code>Promise&lt;<a href="#mdnsdiscoverresult">MdnsDiscoverResult</a>&gt;</code>

--------------------


### watchServices(...)

```typescript
watchServices(options: MdnsWatchOptions) => Promise<MdnsWatchResult>
```

Continuously watch several service types. A valid call replaces the previous watch.
Register listeners before starting. Each resolved service emits `serviceFound` once;
disappearance emits `serviceLost` with its last snapshot. No loss is emitted for an
unresolved service. Watching and one-shot discovery can run together.
Thanks to Idrimi for contributing the original continuous discovery feature (PR #7).

| Param         | Type                                                          |
| ------------- | ------------------------------------------------------------- |
| **`options`** | <code><a href="#mdnswatchoptions">MdnsWatchOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#mdnswatchresult">MdnsWatchResult</a>&gt;</code>

--------------------


### stopWatching()

```typescript
stopWatching() => Promise<MdnsWatchStopResult>
```

Stop all watchers. No events from that watch are emitted after this resolves.

**Returns:** <code>Promise&lt;<a href="#mdnswatchstopresult">MdnsWatchStopResult</a>&gt;</code>

--------------------


### addListener('serviceFound' | 'serviceLost', ...)

```typescript
addListener(eventName: 'serviceFound' | 'serviceLost', handler: (event: MdnsServiceEvent) => void) => Promise<PluginListenerHandle>
```

| Param           | Type                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| **`eventName`** | <code>'serviceFound' \| 'serviceLost'</code>                                      |
| **`handler`**   | <code>(event: <a href="#mdnsserviceevent">MdnsServiceEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('watchError', ...)

```typescript
addListener(eventName: 'watchError', handler: (event: MdnsWatchErrorEvent) => void) => Promise<PluginListenerHandle>
```

| Param           | Type                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| **`eventName`** | <code>'watchError'</code>                                                               |
| **`handler`**   | <code>(event: <a href="#mdnswatcherrorevent">MdnsWatchErrorEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### removeAllListeners()

```typescript
removeAllListeners() => Promise<void>
```

--------------------


### Interfaces


#### MdnsPluginPlatformResult

Result of getPluginPlatform(). Useful for validating that calls are routed
through the expected platform bridge.

| Prop           | Type                                                              | Description                                        |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| **`platform`** | <code><a href="#mdnspluginplatform">MdnsPluginPlatform</a></code> | Platform implementation that produced this result. |


#### MdnsBroadcastResult

Result of startBroadcast(). Indicates whether advertising is active
and the final service name. On failure, `error` is true and `errorMessage`
describes the issue.

| Prop               | Type                        | Description                                                                   |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------- |
| **`error`**        | <code>boolean</code>        | True if the operation failed.                                                 |
| **`errorMessage`** | <code>string \| null</code> | Error description or null on success.                                         |
| **`name`**         | <code>string</code>         | Final (possibly uniquified) service instance name. Empty on failure.          |
| **`publishing`**   | <code>boolean</code>        | Whether an advertiser is active, or may still be active after failed cleanup. |


#### MdnsBroadcastOptions

Options for starting a Bonjour/mDNS advertisement.

| Prop       | Type                                        | Description                                                                  |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| **`type`** | <code>string</code>                         | Service type (including the trailing dot).                                   |
| **`name`** | <code>string</code>                         | Service instance name (maximum 63 UTF-8 bytes). Defaults to `DevIOArtsMDNS`. |
| **`port`** | <code>number</code>                         | TCP port to advertise.                                                       |
| **`txt`**  | <code><a href="#mdnstxt">MdnsTxt</a></code> | Optional TXT key–value pairs (UTF-8 strings).                                |


#### MdnsStopResult

Result of stopBroadcast(). Indicates whether the advertiser is active
after the call (normally false) and includes error information.

| Prop               | Type                        | Description                                                                                   |
| ------------------ | --------------------------- | --------------------------------------------------------------------------------------------- |
| **`error`**        | <code>boolean</code>        | True if an error occurred while stopping.                                                     |
| **`errorMessage`** | <code>string \| null</code> | Error description or null on success.                                                         |
| **`publishing`**   | <code>boolean</code>        | False after confirmed stop; true when stopping failed and the advertiser may still be active. |


#### MdnsDiscoverResult

Result of discover(). Contains normalized services and error information.

| Prop                | Type                        | Description                                                                              |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| **`error`**         | <code>boolean</code>        | True if discovery encountered an error (partial results may still be present).           |
| **`errorMessage`**  | <code>string \| null</code> | Error description or null when no error occurred.                                        |
| **`servicesFound`** | <code>number</code>         | Convenience count equal to services.length.                                              |
| **`services`**      | <code>MdnsService[]</code>  | Resolved services with numeric addresses. Empty on error; partial results are discarded. |


#### MdnsService

Normalized description of a discovered Bonjour/mDNS service.
Returned from {@link mDNSPlugin.discover}.

| Prop           | Type                                        | Description                                                                           |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| **`name`**     | <code>string</code>                         | Instance name of the service (may be uniqued by the OS, e.g. "My App (2)").           |
| **`type`**     | <code>string</code>                         | Full service type including the trailing dot, e.g. `"_http._tcp."`.                   |
| **`domain`**   | <code>string</code>                         | Service domain; typically `"local."`.                                                 |
| **`port`**     | <code>number</code>                         | Port the service advertises.                                                          |
| **`hosts`**    | <code>string[]</code>                       | Resolved numeric IP addresses, IPv4 first, then IPv6 with any available scope suffix. |
| **`hostname`** | <code>string</code>                         | Host name when supplied by the platform, e.g. `"my-device.local."`.                   |
| **`txt`**      | <code><a href="#mdnstxt">MdnsTxt</a></code> | TXT dictionary (key → value).                                                         |


#### MdnsDiscoverOptions

Options for Bonjour/mDNS discovery.

| Prop          | Type                 | Description                                                                                                               |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **`type`**    | <code>string</code>  | Service type (including the trailing dot).                                                                                |
| **`name`**    | <code>string</code>  | Optional instance name filter (prefix-safe).                                                                              |
| **`timeout`** | <code>number</code>  | Discovery timeout in milliseconds. Finite numbers only; fractions are truncated and the delay is clamped to 0–2147483647. |
| **`useNW`**   | <code>boolean</code> | iOS-only hint to use `NWBrowser` instead of `NetServiceBrowser`.                                                          |


#### MdnsWatchResult

Native browsers have been requested; later failures are reported through `watchError`.

| Prop                  | Type                        |
| --------------------- | --------------------------- |
| **`error`**           | <code>boolean</code>        |
| **`errorMessage`**    | <code>string \| null</code> |
| **`watchersStarted`** | <code>number</code>         |


#### MdnsWatchOptions

Options for continuous discovery on iOS, Android and Electron.

| Prop        | Type                  | Description                                                                        |
| ----------- | --------------------- | ---------------------------------------------------------------------------------- |
| **`types`** | <code>string[]</code> | Nonempty list of service types. Trailing dots are optional; duplicates are merged. |


#### MdnsWatchStopResult

Stops watching independently of any active broadcast.

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`watching`**     | <code>boolean</code>        |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |


#### MdnsServiceEvent

Both found and lost events contain a complete service snapshot, including `hosts`.

| Prop          | Type                                                |
| ------------- | --------------------------------------------------- |
| **`service`** | <code><a href="#mdnsservice">MdnsService</a></code> |


#### MdnsWatchErrorEvent

Browser failures stop the watch; exhausted service resolution retries leave it running.

| Prop               | Type                 |
| ------------------ | -------------------- |
| **`type`**         | <code>string</code>  |
| **`errorMessage`** | <code>string</code>  |
| **`watching`**     | <code>boolean</code> |


### Type Aliases


#### MdnsPluginPlatform

Runtime implementation that handled a plugin call.

<code>'ios' | 'android' | 'electron' | 'web'</code>


#### MdnsTxt

Key–value map for TXT records of a Bonjour/mDNS service.
Values are UTF-8 strings; binary payloads are not supported by this API.

<code><a href="#record">Record</a>&lt;string, string&gt;</code>


#### Record

Construct a type with a set of properties K of type T

<code>{ [P in K]: T; }</code>

</docgen-api>
