// src/web.ts
import { WebPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

import type {
  mDNSPlugin,
  MdnsBroadcastOptions,
  MdnsDiscoverOptions,
  MdnsBroadcastResult,
  MdnsStopResult,
  MdnsDiscoverResult,
  MdnsPluginPlatformResult,
  MdnsWatchOptions,
  MdnsWatchResult,
  MdnsWatchStopResult,
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
  private readonly unsupportedMessage = 'mDNS is not supported in this browser runtime';

  /** Electron preload bridge (if present). */
  private get electronApi():
    | undefined
    | {
        startBroadcast(o: MdnsBroadcastOptions): Promise<MdnsBroadcastResult>;
        stopBroadcast(): Promise<MdnsStopResult>;
        discover(o?: MdnsDiscoverOptions): Promise<MdnsDiscoverResult>;
        getPluginPlatform?(): Promise<MdnsPluginPlatformResult>;
        watchServices?(options: MdnsWatchOptions): Promise<MdnsWatchResult>;
        stopWatching?(): Promise<MdnsWatchStopResult>;
        addListener?(eventName: string, handler: (data: any) => void): Promise<PluginListenerHandle>;
        removeAllListeners?(): Promise<void>;
      } {
    if (typeof window === 'undefined') return undefined;
    return (window as any).mDNS || (window as any).mdns;
  }

  async getPluginPlatform(): Promise<MdnsPluginPlatformResult> {
    const api = this.electronApi;
    if (api?.getPluginPlatform) return api.getPluginPlatform();
    return { platform: 'web' };
  }

  async startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult> {
    const api = this.electronApi;
    if (api?.startBroadcast) return api.startBroadcast(options);
    console.log('[WEB_NOT_SUPPORTED] startBroadcast', options);
    return { publishing: false, name: '', error: true, errorMessage: this.unsupportedMessage };
  }

  async stopBroadcast(): Promise<MdnsStopResult> {
    const api = this.electronApi;
    if (api?.stopBroadcast) return api.stopBroadcast();
    console.log('[WEB_NOT_SUPPORTED] stopBroadcast');
    return { publishing: false, error: false, errorMessage: null };
  }

  async discover(options: MdnsDiscoverOptions = {}): Promise<MdnsDiscoverResult> {
    const api = this.electronApi;
    if (api?.discover) return api.discover(options);
    console.log('[WEB_NOT_SUPPORTED] discover', options);
    return { services: [], error: true, errorMessage: this.unsupportedMessage, servicesFound: 0 };
  }

  async watchServices(options: MdnsWatchOptions): Promise<MdnsWatchResult> {
    if (this.electronApi?.watchServices) return this.electronApi.watchServices(options);
    return { error: true, errorMessage: this.unsupportedMessage, watchersStarted: 0 };
  }

  async stopWatching(): Promise<MdnsWatchStopResult> {
    if (this.electronApi?.stopWatching) return this.electronApi.stopWatching();
    return { watching: false, error: false, errorMessage: null };
  }

  async addListener(eventName: string, handler: (data: any) => void): Promise<PluginListenerHandle> {
    if (this.electronApi?.addListener) return this.electronApi.addListener(eventName, handler);
    return super.addListener(eventName, handler);
  }

  async removeAllListeners(): Promise<void> {
    await this.electronApi?.removeAllListeners?.();
    await super.removeAllListeners();
  }
}
