# Contributing

Thanks for helping improve `@devioarts/capacitor-mdns`.

## Local Checks

Run the same checks before opening a pull request:

```bash
npm run build
npm run lint
npm test
npm run verify:android
```

`npm test` runs the Electron e2e flow, which publishes a local mDNS service, discovers it, and
stops it again. Android and iOS native runtime behavior still depends on real devices or platform
simulators because local-network permissions and multicast routing vary by environment.

## Documentation

The API section in `README.md` is generated from `src/definitions.ts`.

```bash
npm run docgen
```

Update the JSDoc comments first, then regenerate the README.
