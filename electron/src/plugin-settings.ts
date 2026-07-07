/**
 * Metadata consumed by the capacitor-electron runtime generator (`npm run update`).
 *
 * Import path for the JS layer: `@devioarts/capacitor-mdns/electron/settings`.
 */
export const pluginSettings = {
  pluginClass: 'mDNS',
  pluginMethods: ['getPluginPlatform', 'startBroadcast', 'stopBroadcast', 'discover'] as const,
  pluginEvents: [] as const,
} as const;

export type PluginSettings = typeof pluginSettings;
