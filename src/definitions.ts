// src/definitions.ts

import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Key–value map for TXT records of a Bonjour/mDNS service.
 * Values are UTF-8 strings; binary payloads are not supported by this API.
 * @public
 */
export type MdnsTxt = Record<string, string>;

/**
 * Runtime implementation that handled a plugin call.
 * @public
 */
export type MdnsPluginPlatform = 'ios' | 'android' | 'electron' | 'web';

/**
 * Result of getPluginPlatform(). Useful for validating that calls are routed
 * through the expected platform bridge.
 * @public
 */
export interface MdnsPluginPlatformResult {
  /** Platform implementation that produced this result. */
  platform: MdnsPluginPlatform;
}

/**
 * Normalized description of a discovered Bonjour/mDNS service.
 * Returned from {@link mDNSPlugin.discover}.
 *
 * @remarks
 * - `hosts` contains resolved IPv4/IPv6 numeric addresses (no DNS names).
 * - IPv4 addresses precede IPv6; order within each family follows discovery order.
 * - Native IPv6 scope suffixes are preserved (`%<scope-id>` on iOS; the OS-provided scope on Android).
 *   Electron may return link-local IPv6 without a scope; callers must not assume every address is reachable.
 * - Resolved TXT records are returned when present.
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

  /** Port the service advertises. */
  port: number;

  /**
   * Resolved numeric IP addresses, IPv4 first, then IPv6 with any available scope suffix.
   * @example
   * `["192.168.1.42", "fe80::1234:abcd:..."]`
   */
  hosts: string[];

  /** Host name when supplied by the platform, e.g. `"my-device.local."`. */
  hostname?: string;

  /**
   * TXT dictionary (key → value).
   * @remarks Not all services publish TXT data.
   */
  txt?: MdnsTxt;
}

/**
 * Options for starting a Bonjour/mDNS advertisement.
 *
 * @remarks
 * - Service types accept an optional trailing dot; results always include it.
 * - Instance `name` should be short and human-readable; the OS may append `" (n)"` to ensure uniqueness.
 *   Electron rejects a name conflict instead of renaming the service.
 * - Advertising TXT is supported on iOS, Android and Electron. Invalid input preserves the active advertisement.
 * - Native implementations guard publish with a timeout and return `error: true` instead of
 *   leaving the Promise pending when the OS does not deliver a publish callback.
 * - Only one advertisement is active at a time. Starting a new one stops the previous one first.
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
   * Service instance name (maximum 63 UTF-8 bytes). Defaults to `DevIOArtsMDNS`.
   */
  name?: string;

  /**
   * TCP port to advertise.
   * @remarks Must be a positive integer (1–65535).
   */
  port: number;

  /**
   * Optional TXT key–value pairs (UTF-8 strings).
   * @remarks Keys must be unique ignoring case, nonempty printable ASCII without `=`. Each `key=value` entry must fit in 255 UTF-8 bytes. The complete record is limited to 1300 bytes including length prefixes. Non-string values are rejected.
   */
  txt?: MdnsTxt;
}

/**
 * Options for Bonjour/mDNS discovery.
 *
 * @remarks
 * - The `name` filter matches the normalized name and also accepts prefix matches
 *   (to handle OS-added `" (n)"` suffixes).
 * - When `useNW` is `true` on iOS, discovery uses `NWBrowser` for better P2P behavior.
 * - A valid new discovery replaces the previous request with an error on every platform.
 * - Dots and hyphens are equivalent when matching names; returned names retain their advertised spelling.
 * - Without a name filter, browsing continues for the entire timeout. With a filter it may finish once a matching IP address resolves.
 *
 * @public
 */
export interface MdnsDiscoverOptions {
  /**
   * Service type (including the trailing dot).
   * @defaultValue `"_http._tcp."`
   * @example `"_comm._tcp."`
   */
  type?: string;

  /**
   * Optional instance name filter (prefix-safe).
   * @example `"MyAppName"`
   */
  name?: string;

  /**
   * Discovery timeout in milliseconds. Finite numbers only; fractions are truncated and the delay is clamped to 0–2147483647.
   * @defaultValue `3000`
   */
  timeout?: number;

  /**
   * iOS-only hint to use `NWBrowser` instead of `NetServiceBrowser`.
   * @defaultValue `true`
   */
  useNW?: boolean;
}

/**
 * Result of startBroadcast(). Indicates whether advertising is active
 * and the final service name. On failure, `error` is true and `errorMessage`
 * describes the issue.
 * @public
 */
export interface MdnsBroadcastResult {
  /** True if the operation failed. */
  error: boolean;
  /** Error description or null on success. */
  errorMessage: string | null;
  /** Final (possibly uniquified) service instance name. Empty on failure. */
  name: string;
  /** Whether an advertiser is active, or may still be active after failed cleanup. */
  publishing: boolean;
}

/**
 * Result of discover(). Contains normalized services and error information.
 * @public
 */
export interface MdnsDiscoverResult {
  /** True if discovery encountered an error (partial results may still be present). */
  error: boolean;
  /** Error description or null when no error occurred. */
  errorMessage: string | null;
  /** Convenience count equal to services.length. */
  servicesFound: number;
  /** Resolved services with numeric addresses. Empty on error; partial results are discarded. */
  services: MdnsService[];
}

/**
 * Result of stopBroadcast(). Indicates whether the advertiser is active
 * after the call (normally false) and includes error information.
 * @public
 */
export interface MdnsStopResult {
  /** True if an error occurred while stopping. */
  error: boolean;
  /** Error description or null on success. */
  errorMessage: string | null;
  /** False after confirmed stop; true when stopping failed and the advertiser may still be active. */
  publishing: boolean;
}

/** Options for continuous discovery on iOS, Android and Electron. */
export interface MdnsWatchOptions {
  /** Nonempty list of service types. Trailing dots are optional; duplicates are merged. */
  types: string[];
}

/** Native browsers have been requested; later failures are reported through `watchError`. */
export interface MdnsWatchResult {
  error: boolean;
  errorMessage: string | null;
  watchersStarted: number;
}

/** Stops watching independently of any active broadcast. */
export interface MdnsWatchStopResult {
  error: boolean;
  errorMessage: string | null;
  watching: boolean;
}

/** Both found and lost events contain a complete service snapshot, including `hosts`. */
export interface MdnsServiceEvent {
  service: MdnsService;
}

/** Browser failures stop the watch; exhausted service resolution retries leave it running. */
export interface MdnsWatchErrorEvent {
  type: string;
  errorMessage: string;
  watching: boolean;
}

/**
 * Public API surface of the Capacitor mDNS plugin.
 *
 * @example
 * ```ts
 * import { mDNS } from 'capacitor-mdns';
 *
 * // Start advertising
 * await mDNS.startBroadcast({ type: '_http._tcp.', name: 'my.app.id', port: 9235 });
 *
 * // Discover services
 * const { services } = await mDNS.discover({ type: '_http._tcp.', timeout: 3000 });
 *
 * // Stop advertising
 * await mDNS.stopBroadcast();
 * ```
 *
 * @public
 */
export interface mDNSPlugin {
  /**
   * Return the platform implementation currently serving plugin calls.
   *
   * @returns Promise resolving to `MdnsPluginPlatformResult`.
   */
  getPluginPlatform(): Promise<MdnsPluginPlatformResult>;

  /**
   * Start advertising a Bonjour/mDNS service.
   *
   * @param options - {@link MdnsBroadcastOptions}
   * @returns Promise resolving to `MdnsBroadcastResult` (`true` on success).
   */
  startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult>;

  /**
   * Stop advertising the currently registered service (no-op if none).
   *
   * @returns Promise resolving to `MdnsStopResult`.
   * @remarks The `publishing` flag may be `false` after a successful stop.
   * Stopping is idempotent and is safe to call even if publishing never fully started.
   */
  stopBroadcast(): Promise<MdnsStopResult>;

  /**
   * Discover services of a given type and optionally filter by instance name.
   *
   * @param options - {@link MdnsDiscoverOptions}
   * @returns Promise resolving to `MdnsDiscoverResult`.
   * @remarks The result list is normalized across platforms.
   */
  discover(options?: MdnsDiscoverOptions): Promise<MdnsDiscoverResult>;

  /**
   * Continuously watch several service types. A valid call replaces the previous watch.
   * Register listeners before starting. Each resolved service emits `serviceFound` once;
   * disappearance emits `serviceLost` with its last snapshot. No loss is emitted for an
   * unresolved service. Watching and one-shot discovery can run together.
   * Thanks to Idrimi for contributing the original continuous discovery feature (PR #7).
   */
  watchServices(options: MdnsWatchOptions): Promise<MdnsWatchResult>;

  /** Stop all watchers. No events from that watch are emitted after this resolves. */
  stopWatching(): Promise<MdnsWatchStopResult>;

  addListener(
    eventName: 'serviceFound' | 'serviceLost',
    handler: (event: MdnsServiceEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: 'watchError', handler: (event: MdnsWatchErrorEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
