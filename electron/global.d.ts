// electron/global.d.ts
import type {
  MdnsBroadcastOptions,
  MdnsBroadcastResult,
  MdnsDiscoverOptions,
  MdnsDiscoverResult,
  MdnsStopResult,
} from '../src/definitions'; // Types only; no runtime import

declare global {
  interface Window {
    /**
     * Electron mDNS API bridge (preload). Mirrors Capacitor methods.
     * Primary name with the same casing as iOS jsName.
     */
    mDNS: {
      startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult>;
      stopBroadcast(): Promise<MdnsStopResult>;
      discover(options?: MdnsDiscoverOptions): Promise<MdnsDiscoverResult>;
    };
    /**
     * Lowercase alias for convenience.
     */
    mdns: Window['mDNS'];
  }
}

export {};
