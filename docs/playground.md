# Playground

The `playground` directory is the maintained example app for this package.

It demonstrates:

- starting, updating and stopping an mDNS advertisement with JSON TXT records;
- discovering services by type and optional name, with visible addresses and TXT;
- watching several service types, with live service lists, found/lost logs and runtime errors;
- using the Electron preload bridge;
- checking `getPluginPlatform()` so you can confirm which runtime implementation handled a call.

Run it from the playground directory:

```shell
npm install
npm run dev
```

For Electron, use the playground together with `devioarts/capacitor-electron`.

If native folders are missing after cloning, create the required platform first with `npx cap add ios`, `npx cap add android`, or `npx cap-electron add` inside `playground`.

For native builds, build the plugin first from the repository root (`npm run build`), then:

```shell
cd playground
npm run build:vite
npx cap sync
npm run open-ios       # or npm run open-android
```

On macOS, the sync hook adds the Local Network usage description and the default `_http._tcp`, `_airplay._tcp` and `_googlecast._tcp` Bonjour types to the generated iOS project, preserving any existing description and custom types. Add other types to `NSBonjourServices` before testing them on iOS.

For Electron use `npm run build` followed by `npm run open-electron` inside `playground`. The build synchronizes the plugin registry before compiling, including all six methods and the three watch events. The default development origin is `http://localhost:5173`.
A regular browser displays the UI but cannot perform mDNS; unsupported calls show an error.

To test continuous discovery:

1. Publish `_http._tcp.` with TXT on one device. Keep both devices on the same Wi-Fi network.
2. On the other device, open Discovery and start watching `_http._tcp., _airplay._tcp., _googlecast._tcp.`.
3. Check the live name, type, port, IP addresses and TXT. Publish a second type and check both appear.
4. Stop a publisher and check its lost event and removal. Abrupt disappearance can take until its advertised TTL expires.
5. Run a one-time search while watching, then stop watching and verify the publisher stays active.
6. Stop the watch, change the types and start again. Switching tabs keeps both operations active; use their Stop buttons for independent cleanup.

Use dots in the advertised name and hyphens in a name filter to verify equivalent matching.
Run a long search and click Replace search to test replacement; the older request is logged as an error.
The Logger panel shows full event snapshots, including the last snapshot on loss.
