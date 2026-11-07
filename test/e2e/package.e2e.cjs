const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
test('npm archive retains native sources and SwiftPM tests but excludes local audits', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mdns-pack-'));
  let pack;
  try {
    [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8', env: { ...process.env, npm_config_cache: cache } }));
  } finally { rmSync(cache, { recursive: true, force: true }); }
  const files = new Set(pack.files.map(file => file.path));
  assert.ok(![...files].some(path => path.startsWith('docs/audits/')));
  for (const path of ['CHANGELOG.md', 'Package.swift', 'ios/Tests/mDNSPluginTests/MDNSTests.swift', 'android/src/main/java/com/devioarts/capacitor/mdns/MdnsValidation.kt', 'docs/runtime-behavior.md', 'electron/mdns-bridge.cjs']) assert.ok(files.has(path), path);
  const pkg = require('../../package.json');
  assert.equal(pkg.name, '@devioarts/capacitor-mdns');
  assert.equal(pkg.peerDependencies['@capacitor/core'], '^8.0.0');
});
