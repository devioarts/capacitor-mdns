# @devioarts/capacitor-mdns

mDNS plugin for Capacitor that supports Bonjour/mDNS advertisements and discovery.

#### Supported platforms: &#x2713; iOS &#x2713; Android &#x2713; Electron
#### Demo (sources): [application](https://github.com/devioarts/capacitor-examples/tree/main/capacitor-mdns) or directly [file](https://github.com/devioarts/capacitor-examples/blob/main/capacitor-mdns/src/Playground.tsx)

## Install

```bash
npm install @devioarts/capacitor-mdns
npx cap sync
```

## Android
#### /android/app/src/main/AndroidManifest.xml
```xml
<uses-permission android:name="android.permission.INTERNET" />
```

## iOS
#### /ios/App/App/Info.plist
```xml
<key>NSLocalNetworkUsageDescription</key>
<string>It is needed for the correct functioning of the application</string>
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
<key>NSBonjourServices</key>
<array>
    <string>_http._tcp</string>
</array>
```

---
## ElectronJS

```shell
npm i bonjour-service@1.3.0
```

> Implementation example was developed on [capacitor-electron](https://github.com/devioarts/capacitor-examples/tree/main/capacitor-electron)
> base, if you run electron differently, you may need to adjust the code.

#### /electron/main.ts

```typescript
// ...
import { mDNS } from '@devioarts/capacitor-mdns/electron/mdns'
// ...
const mdns = new mDNS();
// ...
app.whenReady().then(() => {
	//...
	mdns.init();
	//...
});
/* Or you can use app.on:ready (whenReady is recomended)
app.on('ready', () => {
	// ...
	mdns.init();
	// ...
});
*/

app.on('before-quit', async () => {
	// ...
	mdns.destroy();
	// ...
})
//...
```
### electron/preload.cjs
```javascript
//...
// THIS IS IMPORTANT FOR PLUGIN!
const {createMDNSAPI} = require("@devioarts/capacitor-mdns/electron/mdns-bridge.cjs");
//...
// THIS IS IMPORTANT FOR PLUGIN!
contextBridge.exposeInMainWorld('mDNS', createMDNSAPI({ ipcRenderer }));
contextBridge.exposeInMainWorld('mdns', createMDNSAPI({ ipcRenderer })) // alias
```

---
## API

<docgen-index>

* [`startBroadcast(...)`](#startbroadcast)
* [`stopBroadcast()`](#stopbroadcast)
* [`discover(...)`](#discover)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

Public API surface of the Capacitor mDNS plugin.

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


### Interfaces


#### MdnsBroadcastResult

Result of startBroadcast(). Indicates whether advertising is active
and the final service name. On failure, `error` is true and `errorMessage`
describes the issue.

| Prop               | Type                        | Description                                                          |
| ------------------ | --------------------------- | -------------------------------------------------------------------- |
| **`error`**        | <code>boolean</code>        | True if the operation failed.                                        |
| **`errorMessage`** | <code>string \| null</code> | Error description or null on success.                                |
| **`name`**         | <code>string</code>         | Final (possibly uniquified) service instance name. Empty on failure. |
| **`publishing`**   | <code>boolean</code>        | Whether the advertiser is currently active.                          |


#### MdnsBroadcastOptions

Options for starting a Bonjour/mDNS advertisement.

| Prop       | Type                                        | Description                                   |
| ---------- | ------------------------------------------- | --------------------------------------------- |
| **`type`** | <code>string</code>                         | Service type (including the trailing dot).    |
| **`name`** | <code>string</code>                         | Service instance name.                        |
| **`port`** | <code>number</code>                         | TCP port to advertise.                        |
| **`txt`**  | <code><a href="#mdnstxt">MdnsTxt</a></code> | Optional TXT key–value pairs (UTF-8 strings). |


#### MdnsStopResult

Result of stopBroadcast(). Indicates whether the advertiser is active
after the call (normally false) and includes error information.

| Prop               | Type                        | Description                                                         |
| ------------------ | --------------------------- | ------------------------------------------------------------------- |
| **`error`**        | <code>boolean</code>        | True if an error occurred while stopping.                           |
| **`errorMessage`** | <code>string \| null</code> | Error description or null on success.                               |
| **`publishing`**   | <code>boolean</code>        | Whether the advertiser remains active (should be false on success). |


#### MdnsDiscoverResult

Result of discover(). Contains normalized services and error information.

| Prop                | Type                        | Description                                                                    |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| **`error`**         | <code>boolean</code>        | True if discovery encountered an error (partial results may still be present). |
| **`errorMessage`**  | <code>string \| null</code> | Error description or null when no error occurred.                              |
| **`servicesFound`** | <code>number</code>         | Convenience count equal to services.length.                                    |
| **`services`**      | <code>MdnsService[]</code>  | Normalized list of discovered services.                                        |


#### MdnsService

Normalized description of a discovered Bonjour/mDNS service.
Returned from {@link mDNSPlugin.discover}.

| Prop         | Type                                        | Description                                                                               |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **`name`**   | <code>string</code>                         | Instance name of the service (may be uniqued by the OS, e.g. "My App (2)").               |
| **`type`**   | <code>string</code>                         | Full service type including the trailing dot, e.g. `"_http._tcp."`.                       |
| **`domain`** | <code>string</code>                         | Service domain; typically `"local."`.                                                     |
| **`port`**   | <code>number</code>                         | TCP port the service advertises.                                                          |
| **`hosts`**  | <code>string[]</code>                       | Resolved numeric IP addresses (IPv4/IPv6).                                                |
| **`txt`**    | <code><a href="#mdnstxt">MdnsTxt</a></code> | TXT dictionary (key → value). Usually present on iOS; Android NSD does not populate this. |


#### MdnsDiscoverOptions

Options for Bonjour/mDNS discovery.

| Prop          | Type                 | Description                                                      |
| ------------- | -------------------- | ---------------------------------------------------------------- |
| **`type`**    | <code>string</code>  | Service type (including the trailing dot).                       |
| **`name`**    | <code>string</code>  | Optional instance name filter (prefix-safe).                     |
| **`timeout`** | <code>number</code>  | Discovery timeout in milliseconds.                               |
| **`useNW`**   | <code>boolean</code> | iOS-only hint to use `NWBrowser` instead of `NetServiceBrowser`. |


### Type Aliases


#### MdnsTxt

Key–value map for TXT records of a Bonjour/mDNS service.
Values are UTF-8 strings; binary payloads are not supported by this API.

<code><a href="#record">Record</a>&lt;string, string&gt;</code>


#### Record

Construct a type with a set of properties K of type T

<code>{
 [P in K]: T;
 }</code>

</docgen-api>
