/**
 * Metadata consumed by the capacitor-electron runtime generator (`npx cap-electron sync`).
 *
 * Import path for the JS layer: `@devioarts/capacitor-mdns/electron/settings`.
 */
export const pluginSettings = {
  pluginClass: 'mDNS',
  pluginMethods: [
    'getPluginPlatform',
    'startBroadcast',
    'stopBroadcast',
    'discover',
    'watchServices',
    'stopWatching',
  ] as const,
  pluginEvents: ['serviceFound', 'serviceLost', 'watchError'] as const,
} as const;

export type PluginSettings = typeof pluginSettings;
