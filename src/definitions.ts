// src/definitions.ts

/**
 * Key–value map for TXT records of a Bonjour/mDNS service.
 * Values are UTF-8 strings; binary payloads are not supported by this API.
 * @public
 */
export type MdnsTxt = Record<string, string>;

/**
 * Normalized description of a discovered Bonjour/mDNS service.
 * Returned from {@link mDNSPlugin.discover}.
 *
 * @remarks
 * - `hosts` contains resolved IPv4/IPv6 numeric addresses (no DNS names).
 * - iOS returns `txt` when present. Android (NSD) does not expose TXT records via public APIs,
 *   so `txt` is usually omitted on Android.
 * - `domain` is typically `"local."`.
 *
 * @public
 */
export interface MdnsService {
  /** Instance name of the service (may be uniqued by the OS, e.g. "My App (2)"). */
  name: string;

  /** Full service type including the trailing dot, e.g. `"_http._tcp."`. */
  type: string;

  /** Service domain; typically `"local."`. */
  domain: string;

  /** TCP port the service advertises. */
  port: number;

  /**
   * Resolved numeric IP addresses (IPv4/IPv6). Empty when resolution fails.
   * @example
   * `["192.168.1.42", "fe80::1234:abcd:..."]`
   */
  hosts?: string[];

  /**
   * TXT dictionary (key → value). Usually present on iOS; Android NSD does not populate this.
   * @remarks Not all services publish TXT data.
   */
  txt?: MdnsTxt;
}

/**
 * Options for starting a Bonjour/mDNS advertisement.
 *
 * @remarks
 * - The `type` **must** end with a dot (`.`). If omitted, the implementation appends it.
 * - Instance `id` should be short and human-readable; the OS may append `" (n)"` to ensure uniqueness.
 * - Android NSD does not expose TXT records to other apps; advertising TXT is supported on iOS.
 *
 * @public
 */
export interface MdnsBroadcastOptions {
  /**
   * Service type (including the trailing dot).
   * @defaultValue `"_http._tcp."`
   * @example `"_myapp._tcp."`
   */
  type?: string;

  /**
   * Service instance name.
   * @defaultValue `"CapacitorMDNS"`
   */
  id?: string;

  /**
   * Bonjour domain.
   * @defaultValue `"local."`
   */
  domain?: string;

  /**
   * TCP port to advertise.
   * @remarks Must be a positive integer (1–65535).
   */
  port: number;

  /**
   * Optional TXT key–value pairs (UTF-8 strings).
   * @remarks May be ignored on Android due to platform limitations.
   */
  txt?: MdnsTxt;
}

/**
 * Options for Bonjour/mDNS discovery.
 *
 * @remarks
 * - The `id` filter matches the normalized name and also accepts prefix matches
 *   (to handle OS-added `" (n)"` suffixes).
 * - When `useNW` is `true` on iOS, discovery uses `NWBrowser` for better P2P behavior.
 *
 * @public
 */
export interface MdnsDiscoverOptions {
  /**
   * Service type (including the trailing dot).
   * @defaultValue `"_http._tcp."`
   * @example `"_lancomm._tcp."`
   */
  type?: string;

  /**
   * Optional instance name filter (prefix-safe).
   * @example `"my.app.id"`
   */
  id?: string;

  /**
   * Discovery timeout in milliseconds.
   * @defaultValue `3000`
   */
  timeoutMs?: number;

  /**
   * iOS-only hint to use `NWBrowser` instead of `NetServiceBrowser`.
   * @defaultValue `true`
   */
  useNW?: boolean;
}

/**
 * Public API surface of the Capacitor mDNS plugin.
 *
 * @example
 * ```ts
 * import { mDNS } from 'capacitor-mdns';
 *
 * // Start advertising
 * await mDNS.startBroadcast({ type: '_http._tcp.', id: 'my.app.id', port: 9235 });
 *
 * // Discover services
 * const { services } = await mDNS.discover({ type: '_http._tcp.', timeoutMs: 3000 });
 *
 * // Stop advertising
 * await mDNS.stopBroadcast();
 * ```
 *
 * @public
 */
export interface mDNSPlugin {
  /**
   * Start advertising a Bonjour/mDNS service.
   *
   * @param options - {@link MdnsBroadcastOptions}
   * @returns Promise resolving to `{ publishing: boolean }` (`true` on success).
   */
  startBroadcast(options: MdnsBroadcastOptions): Promise<{name:string, publishing: boolean }>;

  /**
   * Stop advertising the currently registered service (no-op if none).
   *
   * @returns Promise resolving to `{ publishing: boolean }`.
   * @remarks The `publishing` flag may be `false` after a successful stop.
   */
  stopBroadcast(): Promise<{ publishing: boolean }>;

  /**
   * Discover services of a given type and optionally filter by instance name.
   *
   * @param options - {@link MdnsDiscoverOptions}
   * @returns Promise resolving to `{ services: MdnsService[] }`.
   * @remarks The result list is normalized across platforms. On Android, `txt` is typically absent.
   */
  discover(options?: MdnsDiscoverOptions): Promise<{ services: MdnsService[] }>;
}
