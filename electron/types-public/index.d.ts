import type Bonjour from 'bonjour-service';
import { EventEmitter } from 'node:events';
import type {
  MdnsBroadcastOptions,
  MdnsBroadcastResult,
  MdnsDiscoverOptions,
  MdnsDiscoverResult,
  MdnsPluginPlatformResult,
  MdnsStopResult,
  MdnsWatchOptions,
  MdnsWatchResult,
  MdnsWatchStopResult,
} from '../../dist/esm/definitions';

export type BonjourLike = Pick<Bonjour, 'publish' | 'find' | 'destroy'>;
export interface MdnsOptions {
  publishTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Exact trusted renderer origins, e.g. http://localhost:5173. */
  trustedOrigins?: string[];
}
export declare class mDNS extends EventEmitter {
  constructor(bonjour?: BonjourLike, options?: MdnsOptions);
  getPluginPlatform(): Promise<MdnsPluginPlatformResult>;
  startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult>;
  stopBroadcast(): Promise<MdnsStopResult>;
  discover(options?: MdnsDiscoverOptions): Promise<MdnsDiscoverResult>;
  watchServices(options: MdnsWatchOptions): Promise<MdnsWatchResult>;
  stopWatching(): Promise<MdnsWatchStopResult>;
  init(): void;
  destroy(): Promise<void>;
}

export declare const pluginSettings: {
  readonly pluginClass: 'mDNS';
  readonly pluginMethods: readonly [
    'getPluginPlatform',
    'startBroadcast',
    'stopBroadcast',
    'discover',
    'watchServices',
    'stopWatching',
  ];
  readonly pluginEvents: readonly ['serviceFound', 'serviceLost', 'watchError'];
};

export type PluginSettings = typeof pluginSettings;
