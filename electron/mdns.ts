import Bonjour from 'bonjour-service';
import { ipcMain } from 'electron';

import type {
  MdnsBroadcastOptions,
  MdnsBroadcastResult,
  MdnsDiscoverOptions,
  MdnsDiscoverResult,
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

  //<editor-fold desc="Init/Destroy">
  private ipcRegistered = false;
  private registerIpc(): void {
    if (this.ipcRegistered) return;
    try {
      ipcMain.removeHandler('mdns:startBroadcast');
      ipcMain.removeHandler('mdns:stopBroadcast');
      ipcMain.removeHandler('mdns:discover');
    } catch {
      /* ignore */
    }
    ipcMain.handle('mdns:startBroadcast', (_evt, o: MdnsBroadcastOptions) => this.startBroadcast(o));
    ipcMain.handle('mdns:stopBroadcast', () => this.stopBroadcast());
    ipcMain.handle('mdns:discover', (_evt, o: MdnsDiscoverOptions) => this.discover(o));
    this.ipcRegistered = true;
  }

  private unregisterIpc(): void {
    if (!this.ipcRegistered) return;
    try {
      ipcMain.removeHandler('mdns:startBroadcast');
      ipcMain.removeHandler('mdns:stopBroadcast');
      ipcMain.removeHandler('mdns:discover');
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
    this.unregisterIpc();
    await this.stopBroadcast(); // no-op safe
    try {
      this.bonjour.destroy();
    } catch (err) {
      console.warn('[mDNS] bonjour.destroy error:', err);
    }
  }

  //</editor-fold>

  private bonjour = new Bonjour();
  private advertiser?: Service;

  // ----------------------------- utils -----------------------------
  private toErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
  private validatePort(port: number | undefined): string | null {
    return Number.isInteger(port) && port !== undefined && port > 0 && port <= 65535 ? null : 'Missing/invalid port';
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
  private parseType(typeWithDot?: string): { type: string; protocol: 'tcp' | 'udp' } {
    const s = (typeWithDot ?? '_http._tcp.').replace(/\.$/, '');
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
        try {
          svc.stop(() => res());
        } catch (e) {
          console.warn('[mDNS] service.stop threw:', e);
          res();
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
   * Publish (advertise) a single Bonjour/mDNS service via bonjour-service.
   * @param options See MdnsBroadcastOptions for type/name/port/txt.
   * @returns Result indicating whether publishing is active and the final name.
   */
  async startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult> {
    const portError = this.validatePort(options.port);
    if (portError) return { publishing: false, name: '', error: true, errorMessage: portError };

    await this.stopBroadcast();

    const { type, protocol } = this.parseType(options.type);
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
          name: options.name || 'DevIOArtsMDNS',
          type,
          protocol,
          port: options.port,
          txt: options.txt,
        });

        const onUp = () => {
          try {
            svc.removeListener('up', onUp);
            svc.removeListener('error', onError);
          } catch {
            /* ignore */
          }
          safeResolve({ publishing: true, name: svc.name || '', error: false, errorMessage: null });
        };
        const onError = (err: unknown) => {
          try {
            svc.removeListener('up', onUp);
            svc.removeListener('error', onError);
          } catch {
            /* ignore */
          }
          try {
            if (this.hasCbStop(svc)) svc.stop();
          } catch (e) {
            console.warn('[mDNS] publish stop on error:', e);
          }
          safeResolve({ publishing: false, name: '', error: true, errorMessage: this.toErr(err) });
        };
        const onTimeout = () => {
          try {
            svc.removeListener('up', onUp);
            svc.removeListener('error', onError);
          } catch {
            /* ignore */
          }
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
  }

  /**
   * Stop advertising the current service if any and clear internal state.
   * @returns Result indicating whether the advertiser is active and error info.
   */
  async stopBroadcast(): Promise<MdnsStopResult> {
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
    const { type, protocol } = this.parseType(options.type);
    const targetId = options.name || null;
    const timeoutMs = options.timeout ?? 3000;

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
        (browser as any).on('error', (err: unknown) => {
          hadError = true;
          errMsg = this.toErr(err);
        });

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
