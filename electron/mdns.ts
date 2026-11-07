import Bonjour from 'bonjour-service';
import { app, BrowserWindow, ipcMain } from 'electron';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { isIPv4 } from 'node:net';

import type {
  MdnsBroadcastOptions,
  MdnsBroadcastResult,
  MdnsDiscoverOptions,
  MdnsDiscoverResult,
  MdnsPluginPlatformResult,
  MdnsService,
  MdnsStopResult,
  MdnsWatchOptions,
  MdnsWatchResult,
  MdnsWatchStopResult,
} from '../src/definitions';

type Service = InstanceType<typeof Bonjour.Service>;
type Browser = InstanceType<typeof Bonjour.Browser>;

/** The subset of `bonjour-service` this class uses; injectable so tests can fake the network. */
export type BonjourLike = Pick<Bonjour, 'publish' | 'find' | 'destroy'>;

export interface MdnsOptions {
  /** Max time to wait for a publish to come up (default 5000). */
  publishTimeoutMs?: number;
  /** Max time to wait for a service to stop (default 3000). */
  stopTimeoutMs?: number;
  /** Exact renderer origins allowed in addition to packaged app URLs (e.g. your dev server). */
  trustedOrigins?: string[];
}

const DEFAULT_DISCOVER_TIMEOUT_MS = 3000;
/** `setTimeout` treats delays above 2^31-1 as 1ms, so clamp. */
const MAX_TIMER_MS = 2_147_483_647;

interface Watch {
  types: string[];
  browsers: Browser[];
  services: Map<string, { service: MdnsService; fqdn: string; expires: number; announced: boolean }>;
  timer?: NodeJS.Timeout;
  onResponse?: (packet: { answers?: DnsRecord[]; additionals?: DnsRecord[] }) => void;
}

interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  data: unknown;
}

/**
 * Electron main-process implementation of the mDNS/Bonjour functionality.
 *
 * Uses the `bonjour-service` package to:
 * - publish (advertise) a single service;
 * - discover services of a given type and normalize results to the shared schema;
 * - wire the API over Electron's ipcMain through init().
 *
 * Notes:
 * - Instance name matching is normalized and prefix-safe, mirroring iOS/Android behavior.
 * - TXT records are forwarded as strings when present.
 */
export class mDNS extends EventEmitter {
  private readonly publishTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private broadcastQueue: Promise<unknown> = Promise.resolve();
  private destroyed = false;
  /** Settle callbacks of in-flight discoveries, so destroy() can end them instead of leaving them waiting. */
  private readonly activeDiscoveries = new Set<(abortMessage?: string) => void>();
  private bonjourInstance?: BonjourLike;
  private transport?: EventEmitter & { query?: (name: string, type: string) => void };
  private readonly trustedOrigins: Set<string>;
  private pendingPublishError?: (error: Error) => void;
  private watch?: Watch;
  private networkError?: string;
  private readonly stoppedBrowsers = new Set<Browser>();
  private readonly deactivateBrowser = new Map<Browser, () => void>();

  constructor(bonjour?: BonjourLike, options: MdnsOptions = {}) {
    super();
    this.trustedOrigins = new Set(options.trustedOrigins ?? []);
    if (bonjour) this.attachBonjour(bonjour);
    this.publishTimeoutMs = options.publishTimeoutMs ?? 5000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3000;
  }

  private attachBonjour(bonjour: BonjourLike): BonjourLike {
    this.bonjourInstance = bonjour;
    // shortcut: Bonjour 1.4 needs its internal transport for errors/TTL; recheck these tests on dependency upgrades.
    this.transport = (bonjour as unknown as { server?: { mdns: EventEmitter } }).server?.mdns;
    this.transport?.on('error', this.onNetworkError);
    return bonjour;
  }
  private get bonjour(): BonjourLike {
    return (
      this.bonjourInstance ??
      this.attachBonjour(new Bonjour({}, (err: Error) => console.warn('[mDNS] query response failed:', err)))
    );
  }
  private trustedUrl(raw: string): boolean {
    try {
      const url = new URL(raw);
      // Capacitor Electron's default dev renderer; packaged apps require an explicit origin.
      if (app?.isPackaged === false && `${url.protocol}//${url.host}` === 'http://localhost:5173') return true;
      if (
        url.protocol === 'capacitor-electron:' &&
        url.hostname === 'localhost' &&
        !url.username &&
        !url.password &&
        !url.port
      )
        return true;
      if (url.protocol === 'file:') {
        const path = relative(app.getAppPath(), fileURLToPath(url));
        return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
      }
      return this.trustedOrigins.has(`${url.protocol}//${url.host}`);
    } catch {
      return false;
    }
  }
  private trustedSender(event: Electron.IpcMainInvokeEvent): boolean {
    return (
      !!event.senderFrame && event.senderFrame === event.sender.mainFrame && this.trustedUrl(event.senderFrame.url)
    );
  }
  //<editor-fold desc="Init/Destroy">
  private ipcRegistered = false;
  private registerIpc(): void {
    if (this.ipcRegistered) return;
    try {
      ipcMain.removeHandler('mdns:startBroadcast');
      ipcMain.removeHandler('mdns:stopBroadcast');
      ipcMain.removeHandler('mdns:discover');
      ipcMain.removeHandler('mdns:getPluginPlatform');
      ipcMain.removeHandler('mdns:watchServices');
      ipcMain.removeHandler('mdns:stopWatching');
    } catch {
      /* ignore */
    }
    const handle = (channel: string, action: (options: any) => unknown) => {
      ipcMain.handle(channel, (event, options) => {
        if (!this.trustedSender(event)) throw new Error('Untrusted mDNS IPC sender');
        return action(options);
      });
    };
    handle('mdns:startBroadcast', (o) => this.startBroadcast(o));
    handle('mdns:stopBroadcast', () => this.stopBroadcast());
    handle('mdns:discover', (o) => this.discover(o));
    handle('mdns:getPluginPlatform', () => this.getPluginPlatform());
    handle('mdns:watchServices', (o) => this.watchServices(o));
    handle('mdns:stopWatching', () => this.stopWatching());
    this.ipcRegistered = true;
  }

  private unregisterIpc(): void {
    if (!this.ipcRegistered) return;
    try {
      ipcMain.removeHandler('mdns:startBroadcast');
      ipcMain.removeHandler('mdns:stopBroadcast');
      ipcMain.removeHandler('mdns:discover');
      ipcMain.removeHandler('mdns:getPluginPlatform');
      ipcMain.removeHandler('mdns:watchServices');
      ipcMain.removeHandler('mdns:stopWatching');
    } catch {
      /* ignore */
    }
    this.ipcRegistered = false;
  }
  /** Register manual IPC handlers. Idempotent. */
  init(): void {
    this.registerIpc();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.pendingPublishError?.(new Error('mDNS instance destroyed during publish'));
    await this.stopWatching();
    this.unregisterIpc();
    for (const abort of [...this.activeDiscoveries]) abort('mDNS instance destroyed during discovery');
    await this.withBroadcastLock(async () => {
      await this.stopBroadcastUnlocked();
      try {
        this.bonjourInstance?.destroy();
        this.transport?.removeListener('error', this.onNetworkError);
        this.advertiser = undefined;
      } catch (err) {
        console.warn('[mDNS] bonjour.destroy error:', err);
      }
    });
  }

  //</editor-fold>

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
    return name.replace(/ \(\d+\)$/, '').replace(/\./g, '-');
  }
  private matchesTarget(candidate: string, target?: string | null): boolean {
    if (!target) return true;
    const c = this.normalize(candidate),
      t = this.normalize(target);
    return c === t || c.startsWith(t);
  }
  /**
   * Parse a `_name._tcp.` style type. Absent/blank input means the default `_http._tcp.`;
   * anything malformed is rejected (null) rather than silently advertised as something else.
   */
  private parseType(typeWithDot?: unknown): { type: string; protocol: 'tcp' | 'udp' } | null {
    if (typeWithDot != null && typeof typeWithDot !== 'string') return null;
    const raw = typeof typeWithDot === 'string' && typeWithDot.trim() ? typeWithDot.trim() : '_http._tcp.';
    const m = /^_([a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?)\._(tcp|udp)\.?$/i.exec(raw);
    return m && /[a-z]/i.test(m[1]) && !m[1].includes('--')
      ? { type: m[1].toLowerCase(), protocol: m[2].toLowerCase() as 'tcp' | 'udp' }
      : null;
  }
  private validateName(name: unknown): string | null {
    return name != null &&
      (typeof name !== 'string' || Buffer.byteLength(name.trim(), 'utf8') > 63 || /[\x00-\x1f\x7f]/.test(name))
      ? 'Invalid instance name (maximum 63 UTF-8 bytes, no control characters)'
      : null;
  }
  private validateTxt(txt: unknown): string | null {
    if (txt == null) return null;
    if (!this.isRecord(txt)) return 'TXT must be an object of strings';
    const keys = new Set<string>();
    let totalBytes = 0;
    for (const [key, value] of Object.entries(txt)) {
      if (!/^[\x20-\x7e]+$/.test(key) || key.includes('=') || keys.has(key.toLowerCase()))
        return 'Invalid or duplicate TXT key';
      if (typeof value !== 'string' || Buffer.byteLength(`${key}=${value}`, 'utf8') > 255)
        return 'TXT entries must be strings of at most 255 UTF-8 bytes including key=';
      totalBytes += Buffer.byteLength(`${key}=${value}`, 'utf8') + 1;
      if (totalBytes > 1300) return 'TXT record must fit in 1300 bytes including length prefixes';
      keys.add(key.toLowerCase());
    }
    return null;
  }

  private invalidTypeMessage(typeWithDot: unknown): string {
    return `Invalid service type: ${String(typeWithDot)} (expected e.g. "_http._tcp.")`;
  }
  private normalizeTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DISCOVER_TIMEOUT_MS;
    return Math.min(Math.max(0, Math.trunc(value)), MAX_TIMER_MS);
  }
  private toFullType(type: string, protocol: 'tcp' | 'udp'): string {
    return `_${type}._${protocol}.`;
  }

  private async safeStopService(svc: Service | undefined): Promise<void> {
    if (!svc) return;
    await new Promise<void>((res, reject) => {
      let settled = false;
      const done = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (error) reject(error);
        else res();
      };
      const timeout = setTimeout(
        () => done(new Error(`Timed out waiting for service stop after ${this.stopTimeoutMs}ms`)),
        this.stopTimeoutMs,
      );
      try {
        svc.stop(done);
      } catch (e) {
        done(e);
      }
    });
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
      const portError =
        this.validatePort(safeOptions.port) ?? this.validateName(safeOptions.name) ?? this.validateTxt(safeOptions.txt);
      if (portError) return { publishing: !!this.advertiser, name: '', error: true, errorMessage: portError };
      if (this.destroyed)
        return { publishing: false, name: '', error: true, errorMessage: 'mDNS instance is destroyed' };
      if (this.networkError)
        return { publishing: !!this.advertiser, name: '', error: true, errorMessage: this.networkError };

      const parsed = this.parseType(safeOptions.type);
      if (!parsed) {
        return {
          publishing: !!this.advertiser,
          name: '',
          error: true,
          errorMessage: this.invalidTypeMessage(safeOptions.type),
        };
      }
      const { type, protocol } = parsed;

      const stopped = await this.stopBroadcastUnlocked();
      if (stopped.error) return { ...stopped, name: '' };

      return new Promise<MdnsBroadcastResult>((resolve) => {
        let settled = false;
        let failing = false;
        let timeout: NodeJS.Timeout | null = null;
        const safeResolve = (r: MdnsBroadcastResult) => {
          if (!settled) {
            settled = true;
            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }
            this.pendingPublishError = undefined;
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
            if (failing || settled) return;
            cleanupListeners();
            safeResolve({ publishing: true, name: svc.name || '', error: false, errorMessage: null });
          };
          const onError = async (err: unknown) => {
            if (failing || settled) return;
            failing = true;
            if (timeout) clearTimeout(timeout);
            timeout = null;
            cleanupListeners();
            const stopped = await this.stopBroadcastUnlocked();
            safeResolve({
              publishing: stopped.publishing,
              name: '',
              error: true,
              errorMessage: [this.toErr(err), stopped.errorMessage].filter(Boolean).join('; '),
            });
          };
          const onTimeout = () => {
            void onError(
              new Error(
                svc.activated === false
                  ? 'Service name is already in use on the network'
                  : `Timed out waiting for service publish after ${this.publishTimeoutMs}ms`,
              ),
            );
          };

          // shortcut: Bonjour 1.4 sends goodbye for conflicting probes; remove this hook when its probe teardown is fixed.
          const serviceRecords = svc.records;
          let announcementStarted = svc.published === true;
          svc.records = () => {
            if (svc.destroyed) return [];
            // Bonjour sets published only after the send callback, but records are already registered before it.
            announcementStarted = true;
            return serviceRecords.call(svc);
          };
          const stop = svc.stop.bind(svc);
          svc.stop = (callback?: (error?: unknown) => void) => {
            const announced = announcementStarted || svc.published === true;
            const conflict = !callback && svc.activated && !announced;
            const records = svc.records;
            if (!announced) svc.records = () => [];
            try {
              stop(callback);
              svc.destroyed = true;
            } finally {
              svc.records = records;
            }
            if (conflict) void onError(new Error('Service name is already in use on the network'));
          };

          svc.once('up', onUp);
          svc.once('error', onError);
          timeout = setTimeout(onTimeout, this.publishTimeoutMs);
          this.advertiser = svc;
          this.pendingPublishError = (error) => {
            void onError(error);
          };
          if (this.networkError) this.pendingPublishError(new Error(this.networkError));
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
      return { publishing: !!this.advertiser, error: true, errorMessage: this.toErr(e) };
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
    if (this.networkError) return { error: true, errorMessage: this.networkError, servicesFound: 0, services: [] };

    const parsed = this.parseType(safeOptions.type);
    if (!parsed) {
      return {
        error: true,
        errorMessage: this.invalidTypeMessage(safeOptions.type),
        servicesFound: 0,
        services: [],
      };
    }
    const inputError =
      this.validateName(safeOptions.name) ??
      (safeOptions.timeout != null && (typeof safeOptions.timeout !== 'number' || !Number.isFinite(safeOptions.timeout))
        ? 'Invalid timeout'
        : null);
    if (inputError) return { error: true, errorMessage: inputError, servicesFound: 0, services: [] };
    for (const abort of [...this.activeDiscoveries]) abort('Discovery replaced by a new request');
    const { type, protocol } = parsed;
    const targetId = typeof safeOptions.name === 'string' && safeOptions.name.trim() ? safeOptions.name.trim() : null;
    const timeoutMs = this.normalizeTimeout(safeOptions.timeout);

    let browser: Browser | null = null;
    const services: MdnsService[] = [];
    let hadError = false;
    let errMsg: string | null = null;

    return new Promise<MdnsDiscoverResult>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (abortMessage?: string) => {
        if (settled) return;
        settled = true;
        this.activeDiscoveries.delete(finish);
        this.transport?.removeListener('response', onResponse);
        if (abortMessage) {
          hadError = true;
          errMsg = abortMessage;
        }
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
          services: hadError ? [] : services.filter((s) => s.hosts.length > 0),
          servicesFound: hadError ? 0 : services.filter((s) => s.hosts.length > 0).length,
        });
      };

      const up = (s: Service) => {
        if (settled) return;
        const item = this.serviceResult(s, this.toFullType(type, protocol));
        if (!this.matchesTarget(item.name, targetId)) return;
        const previous = services.find((x) => x.name === item.name && x.port === item.port);
        if (previous) Object.assign(previous, item, { hosts: this.orderHosts([...previous.hosts, ...item.hosts]) });
        else services.push(item);
        if (targetId && item.hosts.length) finish();
        else if (!item.hosts.length && item.hostname) {
          this.queryAddresses(item.hostname);
        }
      };
      const onResponse = (packet: { answers?: DnsRecord[]; additionals?: DnsRecord[] }) => {
        if (settled) return;
        const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
        for (const item of services) {
          for (const record of records) {
            if (
              (record.type === 'A' || record.type === 'AAAA') &&
              record.ttl &&
              typeof record.data === 'string' &&
              record.name.toLowerCase() === item.hostname?.toLowerCase() &&
              !item.hosts.includes(record.data)
            )
              item.hosts = this.orderHosts([...item.hosts, record.data]);
          }
        }
        if (targetId && services.some((item) => item.hosts.length)) finish();
      };
      this.activeDiscoveries.add(finish);
      try {
        const bonjour = this.bonjour;
        if (settled) return;
        this.transport?.on('response', onResponse);
        browser = bonjour.find({ type, protocol }, up);
        if (settled) {
          this.safeStopBrowser(browser);
          browser = null;
          return;
        }
        browser.on('srv-update', up);
        browser.on('txt-update', up);
        // Record error and let the timeout conclude; results will still be returned.
        const onBrowserError = (err: unknown) => {
          hadError = true;
          errMsg = this.toErr(err);
        };
        (browser as EventEmitter).on('error', onBrowserError);

        timer = setTimeout(() => finish(), timeoutMs);
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

  private queryAddresses(hostname: string): void {
    try {
      this.transport?.query?.(hostname, 'A');
      this.transport?.query?.(hostname, 'AAAA');
    } catch (err) {
      this.onNetworkError(new Error(this.toErr(err)));
    }
  }
  private orderHosts(hosts: string[]): string[] {
    return [...new Set(hosts)].sort((a, b) => Number(isIPv4(b)) - Number(isIPv4(a)));
  }
  private serviceResult(s: Service, type: string): MdnsService {
    const suffix = `.${type}local`;
    const name = s.fqdn?.toLowerCase().endsWith(suffix.toLowerCase()) ? s.fqdn.slice(0, -suffix.length) : s.name || '';
    return {
      name,
      type,
      domain: 'local.',
      port: s.port ?? 0,
      hosts: this.orderHosts(Array.isArray(s.addresses) ? s.addresses : []),
      ...(s.host ? { hostname: s.host } : {}),
      ...(s.txt && Object.keys(s.txt).length ? { txt: this.normalizeTxt(s.txt) } : {}),
    };
  }

  private notify(event: string, data: unknown): void {
    this.emit(event, data);
    for (const win of BrowserWindow?.getAllWindows() ?? []) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed() && this.trustedUrl(win.webContents.getURL())) {
        win.webContents.send(`event-mDNS-${event}`, data);
        win.webContents.send(`mdns:event:${event}`, data);
      }
    }
  }

  private readonly onNetworkError = (err: Error): void => {
    this.networkError = this.toErr(err);
    this.pendingPublishError?.(err);
    const type = this.watch?.types[0] ?? '';
    const watching = !!this.watch;
    void this.stopWatching();
    for (const abort of [...this.activeDiscoveries]) abort(this.toErr(err));
    if (watching) this.notify('watchError', { type, errorMessage: this.toErr(err), watching: false });
    else console.warn('[mDNS]', err);
  };

  /** Thanks to Idrimi for the original continuous discovery feature (PR #7). */
  async watchServices(options: MdnsWatchOptions): Promise<MdnsWatchResult> {
    const failed = (message: string): MdnsWatchResult => ({ error: true, errorMessage: message, watchersStarted: 0 });
    if (this.destroyed) return failed('mDNS instance is destroyed');
    if (this.networkError) return failed(this.networkError);
    if (!Array.isArray(options?.types) || !options.types.length) return failed("Missing or empty 'types' array");
    const types = new Map<string, { type: string; protocol: 'tcp' | 'udp' }>();
    for (const raw of options.types) {
      const parsed = typeof raw === 'string' && raw.trim() ? this.parseType(raw) : null;
      if (!parsed) return failed(this.invalidTypeMessage(raw));
      types.set(this.toFullType(parsed.type, parsed.protocol), parsed);
    }
    const cleanup = this.stopWatch();
    if (cleanup) return failed(cleanup);
    const bonjour = this.bonjour;
    if (this.networkError) return failed(this.networkError);
    const watch: Watch = { types: [...types.keys()], browsers: [], services: new Map() };
    this.watch = watch;
    const addBrowser = (type: string, parsed: { type: string; protocol: 'tcp' | 'udp' }) => {
      let active = true;
      const up = (s: Service) => {
        if (this.watch !== watch || !active) return;
        const service = this.serviceResult(s, type);
        const key = `${type}|${service.name}`;
        const previous = watch.services.get(key);
        if (!service.hosts.length && previous?.service.hostname === service.hostname)
          service.hosts = [...(previous?.service.hosts ?? [])];
        const isNew = !previous?.announced && service.hosts.length > 0;
        watch.services.set(key, {
          service,
          fqdn: s.fqdn || `${service.name}.${type}local`,
          expires: s.ttl ? Date.now() + s.ttl * 1000 : Infinity,
          announced: !!previous?.announced || isNew,
        });
        if (!service.hosts.length && service.hostname) this.queryAddresses(service.hostname);
        if (isNew) this.notify('serviceFound', { service: structuredClone(service) });
      };
      const browser = bonjour.find(parsed, up);
      browser.on('down', (s: Service) => {
        if (this.watch !== watch || !active) return;
        const key = `${type}|${this.serviceResult(s, type).name}`;
        const previous = watch.services.get(key);
        watch.services.delete(key);
        if (previous?.announced) this.notify('serviceLost', { service: structuredClone(previous.service) });
      });
      browser.on('srv-update', up);
      browser.on('txt-update', up);
      this.deactivateBrowser.set(browser, () => {
        active = false;
      });
      if (this.watch !== watch) {
        this.stopWatchBrowser(browser);
        return;
      }
      watch.browsers.push(browser);
    };
    try {
      for (const [type, parsed] of types) addBrowser(type, parsed);
      if (this.watch !== watch) return failed('Watch stopped during startup');
      watch.onResponse = (packet) => {
        if (this.watch !== watch) return;
        const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
        for (const item of watch.services.values()) {
          const ptr = records.find((r) => r.type === 'PTR' && String(r.data).toLowerCase() === item.fqdn.toLowerCase());
          if (ptr) item.expires = Date.now() + ptr.ttl * 1000;
          const addresses = records.filter(
            (r) =>
              (r.type === 'A' || r.type === 'AAAA') && r.name.toLowerCase() === item.service.hostname?.toLowerCase(),
          );
          for (const address of addresses) {
            if (typeof address.data !== 'string') continue;
            const hosts = item.service.hosts.filter((host) => host !== address.data);
            item.service.hosts = this.orderHosts(address.ttl ? [...hosts, address.data] : hosts);
          }
          if (!item.announced && item.service.hosts.length) {
            item.announced = true;
            this.notify('serviceFound', { service: structuredClone(item.service) });
            if (this.watch !== watch) return;
          }
        }
      };
      this.transport?.on('response', watch.onResponse);
      let ticks = 0;
      watch.timer = setInterval(() => {
        if (this.watch !== watch) return;
        try {
          const expired = [...watch.services.entries()].filter(([, item]) => item.expires <= Date.now());
          for (const [key, item] of expired) {
            watch.services.delete(key);
            if (item.announced) this.notify('serviceLost', { service: structuredClone(item.service) });
            if (this.watch !== watch) return;
          }
          // A fresh Browser forgets expired entries retained by bonjour-service's internal cache.
          if (expired.length) {
            for (const browser of watch.browsers.splice(0)) this.stopWatchBrowser(browser);
            for (const [type, parsed] of types) addBrowser(type, parsed);
          } else if (++ticks % 30 === 0) {
            for (const browser of watch.browsers) browser.update?.();
          }
        } catch (err) {
          this.onNetworkError(err instanceof Error ? err : new Error(this.toErr(err)));
        }
      }, 1000);
      watch.timer.unref();
      return { error: false, errorMessage: null, watchersStarted: types.size };
    } catch (err) {
      this.stopWatch();
      return failed(this.toErr(err));
    }
  }

  private stopWatchBrowser(browser: Browser): void {
    this.deactivateBrowser.get(browser)?.();
    this.deactivateBrowser.delete(browser);
    try {
      browser.stop();
      this.stoppedBrowsers.delete(browser);
    } catch (err) {
      this.stoppedBrowsers.add(browser);
      throw err;
    }
  }

  private stopWatch(): string | null {
    const watch = this.watch;
    this.watch = undefined;
    if (watch?.timer) clearInterval(watch.timer);
    if (watch?.onResponse) this.transport?.removeListener('response', watch.onResponse);
    const errors: string[] = [];
    for (const browser of new Set([...(watch?.browsers ?? []), ...this.stoppedBrowsers])) {
      try {
        this.stopWatchBrowser(browser);
      } catch (err) {
        errors.push(this.toErr(err));
      }
    }
    return errors.length ? errors.join('; ') : null;
  }

  async stopWatching(): Promise<MdnsWatchStopResult> {
    const errorMessage = this.stopWatch();
    return { watching: false, error: !!errorMessage, errorMessage };
  }
}
