import Bonjour from 'bonjour-service';
import { ipcMain } from 'electron';

import type {
  MdnsBroadcastOptions,
  MdnsBroadcastResult,
  MdnsDiscoverOptions,
  MdnsDiscoverResult,
  MdnsPluginPlatformResult,
  MdnsService,
  MdnsStopResult,
} from '../src/definitions';

type Service = InstanceType<typeof Bonjour.Service>;
type Browser = InstanceType<typeof Bonjour.Browser>;

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
export class mDNS {
  private readonly publishTimeoutMs = 5000;
  private readonly stopTimeoutMs = 3000;
  private broadcastQueue: Promise<unknown> = Promise.resolve();
  private destroyed = false;

  //<editor-fold desc="Init/Destroy">
  private ipcRegistered = false;
  private registerIpc(): void {
    if (this.ipcRegistered) return;
    try {
      ipcMain.removeHandler('mdns:startBroadcast');
      ipcMain.removeHandler('mdns:stopBroadcast');
      ipcMain.removeHandler('mdns:discover');
      ipcMain.removeHandler('mdns:getPluginPlatform');
    } catch {
      /* ignore */
    }
    ipcMain.handle('mdns:startBroadcast', (_evt, o: MdnsBroadcastOptions) => this.startBroadcast(o));
    ipcMain.handle('mdns:stopBroadcast', () => this.stopBroadcast());
    ipcMain.handle('mdns:discover', (_evt, o: MdnsDiscoverOptions) => this.discover(o));
    ipcMain.handle('mdns:getPluginPlatform', () => this.getPluginPlatform());
    this.ipcRegistered = true;
  }

  private unregisterIpc(): void {
    if (!this.ipcRegistered) return;
    try {
      ipcMain.removeHandler('mdns:startBroadcast');
      ipcMain.removeHandler('mdns:stopBroadcast');
      ipcMain.removeHandler('mdns:discover');
      ipcMain.removeHandler('mdns:getPluginPlatform');
    } catch {
      /* ignore */
    }
    this.ipcRegistered = false;
  }
  /** Manual IPC registration (if you set autoRegisterIpc: false). Idempotent. */
  init(): void {
    this.registerIpc();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.unregisterIpc();
    await this.withBroadcastLock(async () => {
      await this.stopBroadcastUnlocked();
      try {
        this.bonjour.destroy();
      } catch (err) {
        console.warn('[mDNS] bonjour.destroy error:', err);
      }
    });
  }

  //</editor-fold>

  private bonjour = new Bonjour();
  private advertiser?: Service;

  // ----------------------------- utils -----------------------------
  private toErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
  private validatePort(port: unknown): string | null {
    return Number.isInteger(port) && typeof port === 'number' && port > 0 && port <= 65535
      ? null
      : 'Missing/invalid port';
  }
  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  private withBroadcastLock<T>(work: () => Promise<T>): Promise<T> {
    // Publish and stop share one Bonjour service; serializing them prevents orphaned advertisers.
    const run = this.broadcastQueue.catch(() => undefined).then(work);
    this.broadcastQueue = run.catch(() => undefined);
    return run;
  }

  private normalize(name: string): string {
    return name.replace(/ \(\d+\)$/, '');
  }
  private matchesTarget(candidate: string, target?: string | null): boolean {
    if (!target) return true;
    const c = this.normalize(candidate),
      t = this.normalize(target);
    return c === t || c.startsWith(t);
  }
  private parseType(typeWithDot?: unknown): { type: string; protocol: 'tcp' | 'udp' } {
    const raw = typeof typeWithDot === 'string' && typeWithDot.trim() ? typeWithDot.trim() : '_http._tcp.';
    const s = raw.replace(/\.$/, '');
    const m = /^_([^.]+)\._(tcp|udp)$/.exec(s);
    if (!m) return { type: 'http', protocol: 'tcp' };
    return { type: m[1], protocol: m[2] as 'tcp' | 'udp' };
  }
  private toFullType(type: string, protocol: 'tcp' | 'udp'): string {
    return `_${type}._${protocol}.`;
  }

  private hasCbStop(x: unknown): x is { stop: (cb?: () => void) => void } {
    return !!x && typeof (x as any).stop === 'function';
  }
  private async safeStopService(svc: Service | undefined): Promise<void> {
    if (!svc || !this.hasCbStop(svc)) return;
    try {
      await new Promise<void>((res) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          res();
        };
        const timeout = setTimeout(done, this.stopTimeoutMs);
        try {
          svc.stop(done);
        } catch (e) {
          console.warn('[mDNS] service.stop threw:', e);
          done();
        }
      });
    } catch (err) {
      console.warn('[mDNS] service.stop error:', err);
    }
  }
  private safeStopBrowser(b: Browser | null | undefined): void {
    if (!b) return;
    try {
      b.stop();
    } catch (err) {
      console.warn('[mDNS] browser.stop error:', err);
    }
  }

  // ----------------------------- API -----------------------------
  /**
   * Return the Electron main-process implementation marker.
   */
  async getPluginPlatform(): Promise<MdnsPluginPlatformResult> {
    return { platform: 'electron' };
  }

  /**
   * Publish (advertise) a single Bonjour/mDNS service via bonjour-service.
   * @param options See MdnsBroadcastOptions for type/name/port/txt.
   * @returns Result indicating whether publishing is active and the final name.
   */
  async startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult> {
    return this.withBroadcastLock(async () => {
      const safeOptions = (options ?? {}) as Partial<MdnsBroadcastOptions>;
      const portError = this.validatePort(safeOptions.port);
      if (portError) return { publishing: false, name: '', error: true, errorMessage: portError };
      if (this.destroyed)
        return { publishing: false, name: '', error: true, errorMessage: 'mDNS instance is destroyed' };

      await this.stopBroadcastUnlocked();

      const { type, protocol } = this.parseType(safeOptions.type);
      return new Promise<MdnsBroadcastResult>((resolve) => {
        let settled = false;
        let timeout: NodeJS.Timeout | null = null;
        const safeResolve = (r: MdnsBroadcastResult) => {
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
            name:
              typeof safeOptions.name === 'string' && safeOptions.name.trim()
                ? safeOptions.name.trim()
                : 'DevIOArtsMDNS',
            type,
            protocol,
            port: safeOptions.port as number,
            txt: this.isRecord(safeOptions.txt) ? this.normalizeTxt(safeOptions.txt) : undefined,
          });

          const cleanupListeners = () => {
            try {
              svc.removeListener('up', onUp);
              svc.removeListener('error', onError);
            } catch {
              /* ignore */
            }
          };
          const onUp = () => {
            cleanupListeners();
            safeResolve({ publishing: true, name: svc.name || '', error: false, errorMessage: null });
          };
          const onError = (err: unknown) => {
            cleanupListeners();
            void this.safeStopService(svc);
            if (this.advertiser === svc) this.advertiser = undefined;
            safeResolve({ publishing: false, name: '', error: true, errorMessage: this.toErr(err) });
          };
          const onTimeout = () => {
            cleanupListeners();
            void this.safeStopService(svc);
            if (this.advertiser === svc) this.advertiser = undefined;
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
        } catch (e) {
          safeResolve({ publishing: false, name: '', error: true, errorMessage: this.toErr(e) });
        }
      });
    });
  }

  /**
   * Stop advertising the current service if any and clear internal state.
   * @returns Result indicating whether the advertiser is active and error info.
   */
  async stopBroadcast(): Promise<MdnsStopResult> {
    return this.withBroadcastLock(() => this.stopBroadcastUnlocked());
  }

  private async stopBroadcastUnlocked(): Promise<MdnsStopResult> {
    try {
      if (this.advertiser) {
        await this.safeStopService(this.advertiser);
        this.advertiser = undefined;
      }
      return { publishing: false, error: false, errorMessage: null };
    } catch (e) {
      return { publishing: false, error: true, errorMessage: this.toErr(e) };
    }
  }

  /**
   * Discover services of the given type and optionally filter by instance name.
   * Deduplicates by (name:port), collects IPv4/IPv6 addresses and TXT, and
   * resolves with either an early-exit match or after a timeout.
   * @param options See MdnsDiscoverOptions for type/name/timeout.
   */
  async discover(options: MdnsDiscoverOptions = {}): Promise<MdnsDiscoverResult> {
    const safeOptions = (options ?? {}) as Partial<MdnsDiscoverOptions>;
    if (this.destroyed) {
      return { error: true, errorMessage: 'mDNS instance is destroyed', servicesFound: 0, services: [] };
    }

    const { type, protocol } = this.parseType(safeOptions.type);
    const targetId = typeof safeOptions.name === 'string' && safeOptions.name ? safeOptions.name : null;
    const timeoutMs = typeof safeOptions.timeout === 'number' ? safeOptions.timeout : 3000;

    let browser: Browser | null = null;
    const services: MdnsService[] = [];
    let hadError = false;
    let errMsg: string | null = null;

    return new Promise<MdnsDiscoverResult>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = () => {
        if (settled) return;
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
          if (!this.matchesTarget(s.name || '', targetId)) return;
          const item: MdnsService = {
            name: s.name || '',
            type: this.toFullType(type, protocol),
            domain: 'local.',
            port: s.port ?? 0,
            hosts: Array.isArray(s.addresses) ? s.addresses.slice() : [],
            txt: s.txt && Object.keys(s.txt).length ? this.normalizeTxt(s.txt) : undefined,
          };
          const key = `${item.name}:${item.port}`;
          if (!services.some((x) => `${x.name}:${x.port}` === key)) services.push(item);
          if (targetId && this.matchesTarget(item.name, targetId)) finish();
        });

        // Record error and let the timeout conclude; results will still be returned.
        const onBrowserError = (err: unknown) => {
          hadError = true;
          errMsg = this.toErr(err);
        };
        (browser as any).on('error', onBrowserError);

        timer = setTimeout(finish, Math.max(0, timeoutMs));
      } catch (err) {
        hadError = true;
        errMsg = this.toErr(err);
        finish();
      }
    });
  }

  private normalizeTxt(txt: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(txt).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString('utf8') : String(value)]),
    );
  }
}
