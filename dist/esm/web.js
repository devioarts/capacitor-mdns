// src/web.ts
import { WebPlugin } from '@capacitor/core';
/**
 * Web implementation of the mDNS plugin.
 *
 * This class behaves as a thin proxy:
 * - In Electron (when a preload exposes window.mDNS/window.mdns), calls are forwarded over IPC.
 * - In a regular browser, mDNS is not available; methods resolve with well-shaped stub values
 *   and log a console message with the [WEB_NOT_SUPPORTED] tag.
 */
export class mDNSWeb extends WebPlugin {
    constructor() {
        super(...arguments);
        this.unsupportedMessage = 'mDNS is not supported in this browser runtime';
    }
    /** Electron preload bridge (if present). */
    get electronApi() {
        if (typeof window === 'undefined')
            return undefined;
        return window.mDNS || window.mdns;
    }
    async getPluginPlatform() {
        const api = this.electronApi;
        if (api === null || api === void 0 ? void 0 : api.getPluginPlatform)
            return api.getPluginPlatform();
        return { platform: 'web' };
    }
    async startBroadcast(options) {
        const api = this.electronApi;
        if (api === null || api === void 0 ? void 0 : api.startBroadcast)
            return api.startBroadcast(options);
        console.log('[WEB_NOT_SUPPORTED] startBroadcast', options);
        return { publishing: false, name: '', error: true, errorMessage: this.unsupportedMessage };
    }
    async stopBroadcast() {
        const api = this.electronApi;
        if (api === null || api === void 0 ? void 0 : api.stopBroadcast)
            return api.stopBroadcast();
        console.log('[WEB_NOT_SUPPORTED] stopBroadcast');
        return { publishing: false, error: false, errorMessage: null };
    }
    async discover(options = {}) {
        const api = this.electronApi;
        if (api === null || api === void 0 ? void 0 : api.discover)
            return api.discover(options);
        console.log('[WEB_NOT_SUPPORTED] discover', options);
        return { services: [], error: true, errorMessage: this.unsupportedMessage, servicesFound: 0 };
    }
}
//# sourceMappingURL=web.js.map