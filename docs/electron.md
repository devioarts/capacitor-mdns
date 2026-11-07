# Electron setup

Electron support is maintained for
[`devioarts/capacitor-electron`](https://github.com/devioarts/capacitor-electron).

## Capacitor Electron

Use the root package API in application code, the same as iOS and Android:

```ts
import { mDNS } from '@devioarts/capacitor-mdns';

await mDNS.startBroadcast({ type: '_http._tcp.', name: 'MyService', port: 9100 });
const platform = await mDNS.getPluginPlatform();
```

The Electron runtime generator reads plugin metadata from:

```ts
import { pluginSettings } from '@devioarts/capacitor-mdns/electron/settings';
```

After installing or updating the plugin, run `npx cap-electron sync` in the application. If the
generated runtime has no `mDNS` plugin, the root API rejects with an error identifying this step.
This is a runtime setup error, before a platform implementation can return an operation result.

The Electron main-process plugin class is exported from:

```ts
import { mDNS } from '@devioarts/capacitor-mdns/electron';
```

## Manual bridge

Continuous discovery uses the same `watchServices`, `stopWatching` and `addListener` API as native
platforms. After updating the plugin, run `npx cap-electron sync` so the generated metadata includes
the new methods and the `serviceFound`, `serviceLost`, `watchError` events.

The older manual bridge remains available for apps that do not use
`devioarts/capacitor-electron`.

The Electron runtime needs `bonjour-service`. It is declared as an optional peer dependency
(only Electron apps need it), so install it in the Electron app:

```shell
npm i bonjour-service@~1.4.0
```

The supported range is `~1.4.0` because probe cleanup uses Bonjour 1.4 service behavior. Before widening
it, run the real-registry regressions for conflicts, pending announcements and goodbye packets.

### Main process

```ts
import { app } from 'electron';
import { mDNS } from '@devioarts/capacitor-mdns/electron';

const mdns = new mDNS(undefined, {
  // Only needed for an exact development server or a custom application origin:
  // trustedOrigins: ['http://localhost:5173'],
});

app.whenReady().then(() => {
  mdns.init();
});

app.on('before-quit', async () => {
  await mdns.destroy();
});
```

### Preload

```js
const { contextBridge, ipcRenderer } = require('electron');
const { createMDNSAPI } = require('@devioarts/capacitor-mdns/electron/mdns-bridge.cjs');

contextBridge.exposeInMainWorld('mDNS', createMDNSAPI({ ipcRenderer }));
contextBridge.exposeInMainWorld('mdns', createMDNSAPI({ ipcRenderer }));
```

### IPC trust

Manual handlers accept calls only from a trusted top-level frame. By default these are
`capacitor-electron://localhost` and `file:` documents inside `app.getAppPath()`.
Unpackaged apps also accept the Capacitor Electron default dev origin `http://localhost:5173`;
that default dev origin is disabled in packaged apps.
For a custom protocol or development server, configure its exact origin with `trustedOrigins`.
Third-party pages, child frames and other origins are rejected. Event delivery uses the same
URL allowlist, so windows displaying remote pages do not receive service data. The generated
Capacitor Electron route additionally applies its runtime's sender validation.
