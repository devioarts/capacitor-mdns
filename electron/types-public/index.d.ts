import type {
  MdnsBroadcastOptions,
  MdnsBroadcastResult,
  MdnsDiscoverOptions,
  MdnsDiscoverResult,
  MdnsPluginPlatformResult,
  MdnsStopResult,
} from '../../dist/esm/definitions';

export declare class mDNS {
  getPluginPlatform(): Promise<MdnsPluginPlatformResult>;
  startBroadcast(options: MdnsBroadcastOptions): Promise<MdnsBroadcastResult>;
  stopBroadcast(): Promise<MdnsStopResult>;
  discover(options?: MdnsDiscoverOptions): Promise<MdnsDiscoverResult>;
  init(): void;
  destroy(): Promise<void>;
}

export declare const pluginSettings: {
  readonly pluginClass: 'mDNS';
  readonly pluginMethods: readonly ['getPluginPlatform', 'startBroadcast', 'stopBroadcast', 'discover'];
  readonly pluginEvents: readonly [];
};

export type PluginSettings = typeof pluginSettings;
