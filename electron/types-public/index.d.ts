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

export declare class mDNS extends EventEmitter {
  constructor();
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
