// electron/global.d.ts
import type {
  MdnsBroadcastOptions,
  MdnsDiscoverOptions,
  MdnsService,
} from '../src' // ← uprav cestu dle struktury

declare global {
  interface Window {
    /**
     * Electron mDNS API bridge (preload). Mirrors Capacitor methods.
     * Primary name with the same casing as iOS jsName.
     */
    mDNS: {
      startBroadcast(options: MdnsBroadcastOptions): Promise<{ publishing: boolean; name: string }>
      stopBroadcast(): Promise<{ publishing: boolean }>
      discover(options?: MdnsDiscoverOptions): Promise<{ services: MdnsService[] }>
    }
    /**
     * Lowercase alias for convenience.
     */
    mdns: Window['mDNS']
  }
}

export {}
