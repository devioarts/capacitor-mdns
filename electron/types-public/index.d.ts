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
