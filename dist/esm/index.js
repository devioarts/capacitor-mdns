import { registerPlugin } from '@capacitor/core';
const mDNS = registerPlugin('mDNS', {
    web: () => import('./web').then((m) => new m.mDNSWeb()),
    electron: () => Promise.resolve(window.CapacitorCustomPlatform.plugins.mDNS),
});
export * from './definitions';
export { mDNS };
//# sourceMappingURL=index.js.map