// src/web.ts
import { WebPlugin } from '@capacitor/core';

import type {
  mDNSPlugin,
  MdnsBroadcastOptions,
  MdnsDiscoverOptions,
  MdnsBroadcastResult,
  MdnsStopResult,
  MdnsDiscoverResult,
} from './definitions';

/**
 * Web implementation of the mDNS plugin.
 *
 * This class behaves as a thin proxy:
 * - In Electron (when a preload exposes window.mDNS/window.mdns), calls are forwarded over IPC.
 * - In a regular browser, mDNS is not available; methods resolve with well-shaped stub values
 *   and log a console message with the [WEB_NOT_SUPPORTED] tag.
 */
export class mDNSWeb extends WebPlugin implements mDNSPlugin {
  /** Electron preload bridge (if present). */
  private get electronApi(): undefined | {
    startBroadcast(o: MdnsBroadcastOptions): Promise<MdnsBroadcastResult>;
    stopBroadcast(): Promise<MdnsStopResult>;
    discover(o?: MdnsDiscoverOptions): Promise<MdnsDiscoverResult>;
  } {
    if (typeof window === 'undefined') return undefined;
    return (window as any).mDNS || (window as any).mdns;
  }

  async startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult> {
    const api = this.electronApi;
    if (api?.startBroadcast) return api.startBroadcast(options);
    console.log('[WEB_NOT_SUPPORTED] startBroadcast',options);
    // Keep the shape consistent even when not supported
    return { publishing: true, name: '',error:false,errorMessage:null };
  }

  async stopBroadcast(): Promise<MdnsStopResult> {
    const api = this.electronApi;
    if (api?.stopBroadcast) return api.stopBroadcast();
    console.log('[WEB_NOT_SUPPORTED] stopBroadcast');
    return { publishing: false, error:false,errorMessage:null };
  }

  async discover(options: MdnsDiscoverOptions = {}): Promise<MdnsDiscoverResult> {
    const api = this.electronApi;
    if (api?.discover) return api.discover(options);
    console.log('[WEB_NOT_SUPPORTED] discover',options);
    return { services: [], error:false,errorMessage:null,servicesFound:0 };
  }
}