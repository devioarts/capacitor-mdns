const assert = require('node:assert/strict');
const test = require('node:test');
const { mDNS } = require('../../.tmp/e2e-build/electron/mdns.js');

test('continuous watch finds and loses real services of two types', async () => {
  const watcher = new mDNS();
  const publishers = [new mDNS(), new mDNS()];
  const types = ['_capmdnswatch._tcp.', '_capmdnsw2._udp.'];
  const names = publishers.map((_, index) => `Watch-${process.pid}-${Date.now()}-${index}`);
  const found = new Map(), lost = new Map();
  watcher.on('serviceFound', event => found.set(event.service.name, event.service));
  watcher.on('serviceLost', event => lost.set(event.service.name, event.service));
  const waitFor = async (condition) => {
    const deadline = Date.now() + 7000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(condition(), `Missing watch events: found=${JSON.stringify([...found])}, lost=${JSON.stringify([...lost])}`);
  };
  try {
    assert.equal((await watcher.watchServices({ types })).watchersStarted, 2);
    for (let i = 0; i < publishers.length; i++) {
      const result = await publishers[i].startBroadcast({ type: types[i], name: names[i], port: 43215 + i, txt: { test: 'watch' } });
      assert.equal(result.error, false, result.errorMessage);
    }
    await waitFor(() => names.every(name => found.has(name)));
    for (const publisher of publishers) await publisher.stopBroadcast();
    await waitFor(() => names.every(name => lost.has(name)));
    for (const name of names) {
      assert.equal(lost.get(name).port, found.get(name).port);
      assert.equal(lost.get(name).type, found.get(name).type);
      assert.ok(Array.isArray(lost.get(name).hosts));
    }
    assert.equal((await watcher.stopWatching()).error, false);
  } finally {
    await Promise.all([watcher, ...publishers].map(instance => instance.destroy()));
  }
});

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

test('Electron mDNS implementation reports its platform', async () => {
  const mdns = new mDNS();

  try {
    const platform = await withTimeout(mdns.getPluginPlatform(), 5000, 'getPluginPlatform');
    assert.deepEqual(platform, { platform: 'electron' });
  } finally {
    await mdns.destroy();
  }
});

test('Electron mDNS implementation returns shaped errors for invalid runtime input', async () => {
  const mdns = new mDNS();

  try {
    const invalidStart = await withTimeout(mdns.startBroadcast(null), 5000, 'invalid startBroadcast');
    assert.equal(invalidStart.error, true);
    assert.equal(invalidStart.publishing, false);
    assert.equal(invalidStart.name, '');
    assert.equal(typeof invalidStart.errorMessage, 'string');

    const invalidDiscover = await withTimeout(mdns.discover(null), 5000, 'invalid discover');
    assert.equal(invalidDiscover.error, false);
    assert.equal(invalidDiscover.errorMessage, null);
    assert.equal(invalidDiscover.servicesFound, invalidDiscover.services.length);
  } finally {
    await mdns.destroy();
  }
});

test('Electron mDNS implementation serializes overlapping startBroadcast calls', async () => {
  const mdns = new mDNS();
  const type = '_capmdnsrace._tcp.';
  const firstName = `CapMDNSRaceA-${process.pid}-${Date.now()}`;
  const secondName = `CapMDNSRaceB-${process.pid}-${Date.now()}`;

  try {
    const [first, second] = await withTimeout(
      Promise.all([
        mdns.startBroadcast({ type, name: firstName, port: 43211 }),
        mdns.startBroadcast({ type, name: secondName, port: 43212 }),
      ]),
      12000,
      'overlapping startBroadcast',
    );

    assert.equal(first.error, false, first.errorMessage);
    assert.equal(second.error, false, second.errorMessage);
    assert.equal(first.publishing, true);
    assert.equal(second.publishing, true);

    const { discovery, match } = await discoverPublishedService(mdns, type, secondName);
    assert.equal(discovery.error, false, discovery.errorMessage);
    assert.ok(match, `Latest serialized service was not discovered: ${JSON.stringify(discovery)}`);
    assert.equal(match.port, 43212);
  } finally {
    await mdns.destroy();
  }
});
