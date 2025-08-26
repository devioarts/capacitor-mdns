import { registerPlugin } from '@capacitor/core';

import type { mDNSPlugin } from './definitions';

const mDNS = registerPlugin<mDNSPlugin>('mDNS', {
  web: () => import('./web').then((m) => new m.mDNSWeb()),
});

export * from './definitions';
export { mDNS };
