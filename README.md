# @devioarts/capacitor-mdns

mDNS plugin for CapacitorJS

## Install

```bash
npm install @devioarts/capacitor-mdns
npx cap sync
```

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

```bash
npm install @capacitor/ios
npm run build
npx cap add ios --packagemanager SPM
```

### info.plist

```file:ios/App/App/Info.plist
<key>NSLocalNetworkUsageDescription</key>
<string>Local server/client connection</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
<key>NSBonjourServices</key>
<array>
    <string>_http._tcp</string>
    <string>_lancomm._tcp</string>
</array>
```
---
## ElectronJS
```shell
npm i bonjour-service@1.3.0
```
### electron/main.ts
```typescript
// ...
// THIS IS IMPORTANT FOR PLUGIN!
import { registerMdnsIpc } from '@devioarts/capacitor-mdns/electron/mdns'
// ...
app.whenReady().then(() => {
  // THIS IS IMPORTANT FOR PLUGIN!
  registerMdnsIpc();
  //...
});
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

* [`mdnsStartBroadcast(...)`](#mdnsstartbroadcast)
* [`mdnsStopBroadcast()`](#mdnsstopbroadcast)
* [`mdnsDiscover(...)`](#mdnsdiscover)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

Public API surface of the Capacitor mDNS plugin.

### mdnsStartBroadcast(...)

```typescript
mdnsStartBroadcast(options: MdnsBroadcastOptions) => Promise<{ name: string; publishing: boolean; }>
```

Start advertising a Bonjour/mDNS service.

| Param         | Type                                                                  | Description                                                        |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **`options`** | <code><a href="#mdnsbroadcastoptions">MdnsBroadcastOptions</a></code> | - {@link <a href="#mdnsbroadcastoptions">MdnsBroadcastOptions</a>} |

**Returns:** <code>Promise&lt;{ name: string; publishing: boolean; }&gt;</code>

--------------------


### mdnsStopBroadcast()

```typescript
mdnsStopBroadcast() => Promise<{ publishing: boolean; }>
```

Stop advertising the currently registered service (no-op if none).

**Returns:** <code>Promise&lt;{ publishing: boolean; }&gt;</code>

--------------------


### mdnsDiscover(...)

```typescript
mdnsDiscover(options?: MdnsDiscoverOptions | undefined) => Promise<{ services: MdnsService[]; }>
```

Discover services of a given type and optionally filter by instance name.

| Param         | Type                                                                | Description                                                      |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **`options`** | <code><a href="#mdnsdiscoveroptions">MdnsDiscoverOptions</a></code> | - {@link <a href="#mdnsdiscoveroptions">MdnsDiscoverOptions</a>} |

**Returns:** <code>Promise&lt;{ services: MdnsService[]; }&gt;</code>

--------------------


### Interfaces


#### MdnsBroadcastOptions

Options for starting a Bonjour/mDNS advertisement.

| Prop         | Type                                        | Description                                   |
| ------------ | ------------------------------------------- | --------------------------------------------- |
| **`type`**   | <code>string</code>                         | Service type (including the trailing dot).    |
| **`id`**     | <code>string</code>                         | Service instance name.                        |
| **`domain`** | <code>string</code>                         | Bonjour domain.                               |
| **`port`**   | <code>number</code>                         | TCP port to advertise.                        |
| **`txt`**    | <code><a href="#mdnstxt">MdnsTxt</a></code> | Optional TXT key–value pairs (UTF-8 strings). |


#### MdnsService

Normalized description of a discovered Bonjour/mDNS service.
Returned from {@link mDNSPlugin.mdnsDiscover}.

| Prop         | Type                                        | Description                                                                               |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **`name`**   | <code>string</code>                         | Instance name of the service (may be uniqued by the OS, e.g. "My App (2)").               |
| **`type`**   | <code>string</code>                         | Full service type including the trailing dot, e.g. `"_http._tcp."`.                       |
| **`domain`** | <code>string</code>                         | Service domain; typically `"local."`.                                                     |
| **`port`**   | <code>number</code>                         | TCP port the service advertises.                                                          |
| **`hosts`**  | <code>string[]</code>                       | Resolved numeric IP addresses (IPv4/IPv6). Empty when resolution fails.                   |
| **`txt`**    | <code><a href="#mdnstxt">MdnsTxt</a></code> | TXT dictionary (key → value). Usually present on iOS; Android NSD does not populate this. |


#### MdnsDiscoverOptions

Options for Bonjour/mDNS discovery.

| Prop            | Type                 | Description                                                      |
| --------------- | -------------------- | ---------------------------------------------------------------- |
| **`type`**      | <code>string</code>  | Service type (including the trailing dot).                       |
| **`id`**        | <code>string</code>  | Optional instance name filter (prefix-safe).                     |
| **`timeoutMs`** | <code>number</code>  | Discovery timeout in milliseconds.                               |
| **`useNW`**     | <code>boolean</code> | iOS-only hint to use `NWBrowser` instead of `NetServiceBrowser`. |


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
