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

The Electron main-process plugin class is exported from:

```ts
import { mDNS } from '@devioarts/capacitor-mdns/electron';
```

## Manual bridge

The older manual bridge remains available for apps that do not use
`devioarts/capacitor-electron`.

Install the runtime Bonjour dependency in the Electron app:

```shell
npm i bonjour-service@1.4.0
```

### Main process

```ts
import { app } from 'electron';
import { mDNS } from '@devioarts/capacitor-mdns/electron';

const mdns = new mDNS();

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
