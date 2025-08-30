// src/web.ts
import { WebPlugin } from '@capacitor/core';

import type {
  mDNSPlugin,
  MdnsBroadcastOptions,
  MdnsDiscoverOptions
} from './definitions';

export class mDNSWeb extends WebPlugin implements mDNSPlugin {

  private get electronApi() {
    if (typeof window === 'undefined') return undefined
    return (window as any).mDNS || (window as any).mdns
  }

  async startBroadcast(options:MdnsBroadcastOptions): Promise<{name:string, publishing: boolean }> {
    const api = this.electronApi
    if (api?.startBroadcast) return api.startBroadcast(options)
    console.log("[NOT_SUPPORTED] startBroadcast", options);
    return {name:"Not implemented on web", publishing: true };
  }

  async stopBroadcast(): Promise<{ publishing: boolean }> {
    const api = this.electronApi
    if (api?.stopBroadcast) return api.stopBroadcast()
    console.log("[NOT_SUPPORTED] startBroadcast");
    return { publishing: false };
  }
  async discover(options: MdnsDiscoverOptions = {}): Promise< { services: any[] }>{
    const api = this.electronApi
    if (api?.discover) return api.discover(options)

    console.log("[NOT_SUPPORTED] discover");
    return { services: [] };
  }
}
