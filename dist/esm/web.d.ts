import { WebPlugin } from '@capacitor/core';
import type { mDNSPlugin, MdnsBroadcastOptions, MdnsDiscoverOptions, MdnsBroadcastResult, MdnsStopResult, MdnsDiscoverResult, MdnsPluginPlatformResult } from './definitions';
/**
 * Web implementation of the mDNS plugin.
 *
 * This class behaves as a thin proxy:
 * - In Electron (when a preload exposes window.mDNS/window.mdns), calls are forwarded over IPC.
 * - In a regular browser, mDNS is not available; methods resolve with well-shaped stub values
 *   and log a console message with the [WEB_NOT_SUPPORTED] tag.
 */
export declare class mDNSWeb extends WebPlugin implements mDNSPlugin {
    private readonly unsupportedMessage;
    /** Electron preload bridge (if present). */
    private get electronApi();
    getPluginPlatform(): Promise<MdnsPluginPlatformResult>;
    startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult>;
    stopBroadcast(): Promise<MdnsStopResult>;
    discover(options?: MdnsDiscoverOptions): Promise<MdnsDiscoverResult>;
}
