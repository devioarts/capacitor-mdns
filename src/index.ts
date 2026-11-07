import { registerPlugin } from '@capacitor/core';

import type { MdnsDiscoverOptions, mDNSPlugin } from './definitions';

const platformPlugin = registerPlugin<mDNSPlugin>('mDNS', {
  web: () => import('./web').then((m) => new m.mDNSWeb()),
  electron: () => {
    const plugin = (window as any).CapacitorCustomPlatform?.plugins?.mDNS as mDNSPlugin | undefined;
    if (!plugin) throw new Error('mDNS Electron plugin is not registered; run npx cap-electron sync in the app');
    return Promise.resolve(plugin);
  },
});

const mDNS = new Proxy(platformPlugin, {
  get(target, property, receiver) {
    if (property !== 'discover') return Reflect.get(target, property, receiver);
    return (options?: MdnsDiscoverOptions) => {
      const timeout = options?.timeout;
      // Native JSON bridges turn NaN/Infinity into null, losing the invalid input.
      if (timeout != null && (typeof timeout !== 'number' || !Number.isFinite(timeout))) {
        return Promise.resolve({ error: true, errorMessage: 'Invalid timeout', servicesFound: 0, services: [] });
      }
      return target.discover(options);
    };
  },
});

export * from './definitions';
export { mDNS };
