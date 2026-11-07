const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

test('playground iOS sync configures local network permission and all example types idempotently', { skip: process.platform !== 'darwin' }, async () => {
  const { configureNativeIOS } = await import('../../playground/scripts/configure-native.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'mdns-playground-'));
  try {
    const plist = join(directory, 'Info.plist');
    const parse = () => JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
    writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>NSBonjourServices</key><array><string>_custom._tcp</string></array></dict></plist>');
    configureNativeIOS(plist);
    const result = parse();
    assert.ok(result.NSLocalNetworkUsageDescription);
    assert.deepEqual(result.NSBonjourServices, ['_custom._tcp', '_http._tcp', '_airplay._tcp', '_googlecast._tcp']);
    const before = readFileSync(plist, 'utf8');
    configureNativeIOS(plist);
    assert.equal(readFileSync(plist, 'utf8'), before);
    writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>NSLocalNetworkUsageDescription</key><string>Custom explanation</string></dict></plist>');
    configureNativeIOS(plist);
    assert.equal(parse().NSLocalNetworkUsageDescription, 'Custom explanation');
    assert.deepEqual(parse().NSBonjourServices, ['_http._tcp', '_airplay._tcp', '_googlecast._tcp']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
