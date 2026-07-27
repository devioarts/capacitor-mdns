'use strict';

var Bonjour = require('bonjour-service');
var electron = require('electron');

/**
 * Electron main-process implementation of the mDNS/Bonjour functionality.
 *
 * Uses the `bonjour-service` package to:
 * - publish (advertise) a single service;
 * - discover services of a given type and normalize results to the shared schema;
 * - wire the API over Electron's ipcMain (see registerIpc/attachOnReady).
 *
 * Notes:
 * - Instance name matching is normalized and prefix-safe, mirroring iOS/Android behavior.
 * - TXT records are forwarded as strings when present.
 */
class mDNS {
    constructor() {
        this.publishTimeoutMs = 5000;
        this.stopTimeoutMs = 3000;
        this.broadcastQueue = Promise.resolve();
        this.destroyed = false;
        //<editor-fold desc="Init/Destroy">
        this.ipcRegistered = false;
        //</editor-fold>
        this.bonjour = new Bonjour();
    }
    registerIpc() {
        if (this.ipcRegistered)
            return;
        try {
            electron.ipcMain.removeHandler('mdns:startBroadcast');
            electron.ipcMain.removeHandler('mdns:stopBroadcast');
            electron.ipcMain.removeHandler('mdns:discover');
            electron.ipcMain.removeHandler('mdns:getPluginPlatform');
        }
        catch (_a) {
            /* ignore */
        }
        electron.ipcMain.handle('mdns:startBroadcast', (_evt, o) => this.startBroadcast(o));
        electron.ipcMain.handle('mdns:stopBroadcast', () => this.stopBroadcast());
        electron.ipcMain.handle('mdns:discover', (_evt, o) => this.discover(o));
        electron.ipcMain.handle('mdns:getPluginPlatform', () => this.getPluginPlatform());
        this.ipcRegistered = true;
    }
    unregisterIpc() {
        if (!this.ipcRegistered)
            return;
        try {
            electron.ipcMain.removeHandler('mdns:startBroadcast');
            electron.ipcMain.removeHandler('mdns:stopBroadcast');
            electron.ipcMain.removeHandler('mdns:discover');
            electron.ipcMain.removeHandler('mdns:getPluginPlatform');
        }
        catch (_a) {
            /* ignore */
        }
        this.ipcRegistered = false;
    }
    /** Manual IPC registration (if you set autoRegisterIpc: false). Idempotent. */
    init() {
        this.registerIpc();
    }
    async destroy() {
        this.destroyed = true;
        this.unregisterIpc();
        await this.withBroadcastLock(async () => {
            await this.stopBroadcastUnlocked();
            try {
                this.bonjour.destroy();
            }
            catch (err) {
                console.warn('[mDNS] bonjour.destroy error:', err);
            }
        });
    }
    // ----------------------------- utils -----------------------------
    toErr(err) {
        return err instanceof Error ? err.message : String(err);
    }
    validatePort(port) {
        return Number.isInteger(port) && typeof port === 'number' && port > 0 && port <= 65535
            ? null
            : 'Missing/invalid port';
    }
    isRecord(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }
    withBroadcastLock(work) {
        // Publish and stop share one Bonjour service; serializing them prevents orphaned advertisers.
        const run = this.broadcastQueue.catch(() => undefined).then(work);
        this.broadcastQueue = run.catch(() => undefined);
        return run;
    }
    normalize(name) {
        return name.replace(/ \(\d+\)$/, '');
    }
    matchesTarget(candidate, target) {
        if (!target)
            return true;
        const c = this.normalize(candidate), t = this.normalize(target);
        return c === t || c.startsWith(t);
    }
    parseType(typeWithDot) {
        const raw = typeof typeWithDot === 'string' && typeWithDot.trim() ? typeWithDot.trim() : '_http._tcp.';
        const s = raw.replace(/\.$/, '');
        const m = /^_([^.]+)\._(tcp|udp)$/.exec(s);
        if (!m)
            return { type: 'http', protocol: 'tcp' };
        return { type: m[1], protocol: m[2] };
    }
    toFullType(type, protocol) {
        return `_${type}._${protocol}.`;
    }
    hasCbStop(x) {
        return !!x && typeof x.stop === 'function';
    }
    async safeStopService(svc) {
        if (!svc || !this.hasCbStop(svc))
            return;
        try {
            await new Promise((res) => {
                let settled = false;
                const done = () => {
                    if (settled)
                        return;
                    settled = true;
                    if (timeout)
                        clearTimeout(timeout);
                    res();
                };
                const timeout = setTimeout(done, this.stopTimeoutMs);
                try {
                    svc.stop(done);
                }
                catch (e) {
                    console.warn('[mDNS] service.stop threw:', e);
                    done();
                }
            });
        }
        catch (err) {
            console.warn('[mDNS] service.stop error:', err);
        }
    }
    safeStopBrowser(b) {
        if (!b)
            return;
        try {
            b.stop();
        }
        catch (err) {
            console.warn('[mDNS] browser.stop error:', err);
        }
    }
    // ----------------------------- API -----------------------------
    /**
     * Return the Electron main-process implementation marker.
     */
    async getPluginPlatform() {
        return { platform: 'electron' };
    }
    /**
     * Publish (advertise) a single Bonjour/mDNS service via bonjour-service.
     * @param options See MdnsBroadcastOptions for type/name/port/txt.
     * @returns Result indicating whether publishing is active and the final name.
     */
    async startBroadcast(options) {
        return this.withBroadcastLock(async () => {
            const safeOptions = (options !== null && options !== void 0 ? options : {});
            const portError = this.validatePort(safeOptions.port);
            if (portError)
                return { publishing: false, name: '', error: true, errorMessage: portError };
            if (this.destroyed)
                return { publishing: false, name: '', error: true, errorMessage: 'mDNS instance is destroyed' };
            await this.stopBroadcastUnlocked();
            const { type, protocol } = this.parseType(safeOptions.type);
            return new Promise((resolve) => {
                let settled = false;
                let timeout = null;
                const safeResolve = (r) => {
                    if (!settled) {
                        settled = true;
                        if (timeout) {
                            clearTimeout(timeout);
                            timeout = null;
                        }
                        resolve(r);
                    }
                };
                try {
                    const svc = this.bonjour.publish({
                        name: typeof safeOptions.name === 'string' && safeOptions.name.trim()
                            ? safeOptions.name.trim()
                            : 'DevIOArtsMDNS',
                        type,
                        protocol,
                        port: safeOptions.port,
                        txt: this.isRecord(safeOptions.txt) ? this.normalizeTxt(safeOptions.txt) : undefined,
                    });
                    const cleanupListeners = () => {
                        try {
                            svc.removeListener('up', onUp);
                            svc.removeListener('error', onError);
                        }
                        catch (_a) {
                            /* ignore */
                        }
                    };
                    const onUp = () => {
                        cleanupListeners();
                        safeResolve({ publishing: true, name: svc.name || '', error: false, errorMessage: null });
                    };
                    const onError = (err) => {
                        cleanupListeners();
                        void this.safeStopService(svc);
                        if (this.advertiser === svc)
                            this.advertiser = undefined;
                        safeResolve({ publishing: false, name: '', error: true, errorMessage: this.toErr(err) });
                    };
                    const onTimeout = () => {
                        cleanupListeners();
                        void this.safeStopService(svc);
                        if (this.advertiser === svc)
                            this.advertiser = undefined;
                        safeResolve({
                            publishing: false,
                            name: '',
                            error: true,
                            errorMessage: `Timed out waiting for service publish after ${this.publishTimeoutMs}ms`,
                        });
                    };
                    svc.once('up', onUp);
                    svc.once('error', onError);
                    timeout = setTimeout(onTimeout, this.publishTimeoutMs);
                    this.advertiser = svc;
                }
                catch (e) {
                    safeResolve({ publishing: false, name: '', error: true, errorMessage: this.toErr(e) });
                }
            });
        });
    }
    /**
     * Stop advertising the current service if any and clear internal state.
     * @returns Result indicating whether the advertiser is active and error info.
     */
    async stopBroadcast() {
        return this.withBroadcastLock(() => this.stopBroadcastUnlocked());
    }
    async stopBroadcastUnlocked() {
        try {
            if (this.advertiser) {
                await this.safeStopService(this.advertiser);
                this.advertiser = undefined;
            }
            return { publishing: false, error: false, errorMessage: null };
        }
        catch (e) {
            return { publishing: false, error: true, errorMessage: this.toErr(e) };
        }
    }
    /**
     * Discover services of the given type and optionally filter by instance name.
     * Deduplicates by (name:port), collects IPv4/IPv6 addresses and TXT, and
     * resolves with either an early-exit match or after a timeout.
     * @param options See MdnsDiscoverOptions for type/name/timeout.
     */
    async discover(options = {}) {
        const safeOptions = (options !== null && options !== void 0 ? options : {});
        if (this.destroyed) {
            return { error: true, errorMessage: 'mDNS instance is destroyed', servicesFound: 0, services: [] };
        }
        const { type, protocol } = this.parseType(safeOptions.type);
        const targetId = typeof safeOptions.name === 'string' && safeOptions.name ? safeOptions.name : null;
        const timeoutMs = typeof safeOptions.timeout === 'number' ? safeOptions.timeout : 3000;
        let browser = null;
        const services = [];
        let hadError = false;
        let errMsg = null;
        return new Promise((resolve) => {
            let timer = null;
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                if (browser) {
                    this.safeStopBrowser(browser);
                    browser = null;
                }
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                resolve({
                    error: hadError,
                    errorMessage: errMsg,
                    services,
                    servicesFound: services.length,
                });
            };
            try {
                browser = this.bonjour.find({ type, protocol }, (s) => {
                    var _a;
                    if (!this.matchesTarget(s.name || '', targetId))
                        return;
                    const item = {
                        name: s.name || '',
                        type: this.toFullType(type, protocol),
                        domain: 'local.',
                        port: (_a = s.port) !== null && _a !== void 0 ? _a : 0,
                        hosts: Array.isArray(s.addresses) ? s.addresses.slice() : [],
                        txt: s.txt && Object.keys(s.txt).length ? this.normalizeTxt(s.txt) : undefined,
                    };
                    const key = `${item.name}:${item.port}`;
                    if (!services.some((x) => `${x.name}:${x.port}` === key))
                        services.push(item);
                    if (targetId && this.matchesTarget(item.name, targetId))
                        finish();
                });
                // Record error and let the timeout conclude; results will still be returned.
                const onBrowserError = (err) => {
                    hadError = true;
                    errMsg = this.toErr(err);
                };
                browser.on('error', onBrowserError);
                timer = setTimeout(finish, Math.max(0, timeoutMs));
            }
            catch (err) {
                hadError = true;
                errMsg = this.toErr(err);
                finish();
            }
        });
    }
    normalizeTxt(txt) {
        return Object.fromEntries(Object.entries(txt).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('utf8') : String(value)]));
    }
}

exports.mDNS = mDNS;
//# sourceMappingURL=plugin.cjs.js.map
