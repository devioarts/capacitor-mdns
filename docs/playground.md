# Playground

The `playground` directory is the maintained example app for this package.

It demonstrates:

- starting and stopping an mDNS advertisement;
- discovering services by type and optional name;
- using the Electron preload bridge;
- checking `getPluginPlatform()` so you can confirm which runtime implementation handled a call.

Run it from the playground directory:

```shell
npm install
npm run dev
```

For Electron, use the playground together with `devioarts/capacitor-electron`.
