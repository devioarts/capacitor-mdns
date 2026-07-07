const assert = require('node:assert/strict');
const test = require('node:test');
const { mDNS } = require('../../.tmp/e2e-build/electron/mdns.js');

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

async function discoverPublishedService(mdns, type, name) {
  let lastDiscovery = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 750 : 1500));
    const discovery = await withTimeout(
      mdns.discover({ type, name, timeout: 4500 }),
      7000,
      `discover attempt ${attempt + 1}`,
    );
    lastDiscovery = discovery;
    const match = discovery.services.find((service) => service.name.startsWith(name));
    if (match) return { discovery, match };
  }

  return { discovery: lastDiscovery, match: null };
}

test('Electron mDNS implementation publishes, discovers, and stops a local service', async () => {
  const mdns = new mDNS();
  const type = '_capmdnse2e._tcp.';
  const port = 43210;
  const name = `CapMDNSE2E-${process.pid}-${Date.now()}`;

  try {
    const start = await withTimeout(
      mdns.startBroadcast({ type, name, port, txt: { role: 'e2e' } }),
      7000,
      'startBroadcast',
    );
    assert.equal(start.error, false, start.errorMessage);
    assert.equal(start.publishing, true);
    assert.ok(start.name.startsWith(name), `Unexpected published name: ${start.name}`);

    const { discovery, match } = await discoverPublishedService(mdns, type, name);
    assert.equal(discovery.error, false, discovery.errorMessage);
    assert.ok(match, `Published service was not discovered: ${JSON.stringify(discovery)}`);
    assert.equal(match.type, type);
    assert.equal(match.port, port);
    assert.ok(Array.isArray(match.hosts));

    const stop = await withTimeout(mdns.stopBroadcast(), 5000, 'stopBroadcast');
    assert.equal(stop.error, false, stop.errorMessage);
    assert.equal(stop.publishing, false);
  } finally {
    await mdns.destroy();
  }
});
