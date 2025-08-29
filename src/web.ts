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

  async mdnsStartBroadcast(options:MdnsBroadcastOptions): Promise<{name:string, publishing: boolean }> {
    const api = this.electronApi
    if (api?.mdnsStartBroadcast) return api.mdnsStartBroadcast(options)
    console.log("[NOT_SUPPORTED] mdnsStartBroadcast", options);
    return {name:"Not implemented on web", publishing: true };
  }

  async mdnsStopBroadcast(): Promise<{ publishing: boolean }> {
    const api = this.electronApi
    if (api?.mdnsStopBroadcast) return api.mdnsStopBroadcast()
    console.log("[NOT_SUPPORTED] mdnsStartBroadcast");
    return { publishing: false };
  }
  async mdnsDiscover(options: MdnsDiscoverOptions = {}): Promise< { services: any[] }>{
    const api = this.electronApi
    if (api?.mdnsDiscover) return api.mdnsDiscover(options)

    console.log("[NOT_SUPPORTED] mdnsDiscover");
    return { services: [] };
  }
}
