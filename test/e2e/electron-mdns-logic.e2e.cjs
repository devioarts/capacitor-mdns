// Network-free tests of the Electron implementation: bonjour-service is replaced by a fake,
// so these cover filtering, validation, error paths and lifecycle deterministically and fast.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { mDNS } = require('../../.tmp/e2e-build/electron/mdns.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeService extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.name = opts.name;
    this.stopCalls = 0;
  }
  stop(cb) {
    this.stopCalls += 1;
    if (cb) setImmediate(cb);
  }
}

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this.stopCalls = 0;
  }
  stop() {
    this.stopCalls += 1;
  }
}

/** `up` can be suppressed ('hang') or replaced by an `error` ('fail') to exercise failure paths. */
function fakeBonjour({ publish = 'up' } = {}) {
  const fake = {
    published: [],
    browsers: [],
    findCalls: [],
    destroyed: 0,
    publish(opts) {
      const svc = new FakeService(opts);
      fake.published.push(svc);
      if (publish === 'up') setImmediate(() => svc.emit('up'));
      if (publish === 'fail') setImmediate(() => svc.emit('error', new Error('probe conflict')));
      return svc;
    },
    find(opts, onUp) {
      const browser = new FakeBrowser();
      browser.onUp = onUp;
      fake.findCalls.push(opts);
      fake.browsers.push(browser);
      return browser;
    },
    destroy() {
      fake.destroyed += 1;
    },
  };
  return fake;
}

const service = (name, port, extra = {}) => ({ name, port, addresses: ['192.168.1.2'], ...extra });
const lastBrowser = (fake) => fake.browsers[fake.browsers.length - 1];

// ---- service type validation -------------------------------------------------------------

test('malformed service types are rejected instead of silently becoming _http._tcp', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    for (const type of ['http', '_http', '_http._xyz.', 'foo._tcp.', '_a._b._tcp.']) {
      const start = await mdns.startBroadcast({ type, name: 'X', port: 80 });
      assert.equal(start.error, true, `startBroadcast accepted "${type}"`);
      assert.equal(start.publishing, false);
      assert.match(start.errorMessage, /Invalid service type/);

      const found = await mdns.discover({ type, timeout: 10 });
      assert.equal(found.error, true, `discover accepted "${type}"`);
      assert.equal(found.servicesFound, 0);
    }
    assert.equal(fake.published.length, 0);
    assert.equal(fake.findCalls.length, 0);
  } finally {
    await mdns.destroy();
  }
});

test('an invalid type does not tear down the broadcast that is already running', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    const ok = await mdns.startBroadcast({ type: '_good._tcp.', name: 'Good', port: 80 });
    assert.equal(ok.publishing, true);

    const bad = await mdns.startBroadcast({ type: 'nope', name: 'Bad', port: 81 });
    assert.equal(bad.error, true);
    assert.equal(fake.published[0].stopCalls, 0, 'running broadcast must be left alone');
  } finally {
    await mdns.destroy();
  }
});

test('type defaults to _http._tcp and is parsed with or without trailing dot', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    await mdns.startBroadcast({ name: 'A', port: 80 });
    await mdns.startBroadcast({ type: '_ipp._udp', name: 'B', port: 631 });
    assert.deepEqual([fake.published[0].opts.type, fake.published[0].opts.protocol], ['http', 'tcp']);
    assert.deepEqual([fake.published[1].opts.type, fake.published[1].opts.protocol], ['ipp', 'udp']);

    await mdns.discover({ timeout: 5 });
    await mdns.discover({ type: '_ipp._udp.', timeout: 5 });
    assert.deepEqual(fake.findCalls, [
      { type: 'http', protocol: 'tcp' },
      { type: 'ipp', protocol: 'udp' },
    ]);
  } finally {
    await mdns.destroy();
  }
});

// ---- broadcast ----------------------------------------------------------------------------

test('startBroadcast validates ports', async () => {
  const mdns = new mDNS(fakeBonjour());
  try {
    for (const port of [0, -1, 65536, 1.5, '80', undefined, NaN]) {
      const r = await mdns.startBroadcast({ name: 'X', port });
      assert.equal(r.error, true, `port ${String(port)} must be rejected`);
      assert.equal(r.errorMessage, 'Missing/invalid port');
    }
    assert.equal((await mdns.startBroadcast({ name: 'X', port: 65535 })).publishing, true);
  } finally {
    await mdns.destroy();
  }
});

test('startBroadcast reports publish errors and stops the failed service', async () => {
  const fake = fakeBonjour({ publish: 'fail' });
  const mdns = new mDNS(fake);
  try {
    const r = await mdns.startBroadcast({ name: 'X', port: 80 });
    assert.equal(r.error, true);
    assert.equal(r.publishing, false);
    assert.equal(r.errorMessage, 'probe conflict');
    assert.equal(fake.published[0].stopCalls, 1);
  } finally {
    await mdns.destroy();
  }
});

test('startBroadcast times out when the service never comes up', async () => {
  const fake = fakeBonjour({ publish: 'hang' });
  const mdns = new mDNS(fake, { publishTimeoutMs: 40 });
  try {
    const r = await mdns.startBroadcast({ name: 'X', port: 80 });
    assert.equal(r.error, true);
    assert.match(r.errorMessage, /Timed out/);
    assert.equal(fake.published[0].stopCalls, 1);

    fake.published[0].emit('up'); // late event must not resurrect or double-resolve anything
    const stop = await mdns.stopBroadcast();
    assert.equal(stop.error, false);
  } finally {
    await mdns.destroy();
  }
});

test('starting a new broadcast stops the previous one; stopBroadcast is idempotent', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    await mdns.startBroadcast({ name: 'A', port: 80 });
    await mdns.startBroadcast({ name: 'B', port: 81 });
    assert.equal(fake.published[0].stopCalls, 1);
    assert.equal(fake.published[1].stopCalls, 0);

    await mdns.stopBroadcast();
    await mdns.stopBroadcast();
    assert.equal(fake.published[1].stopCalls, 1);
  } finally {
    await mdns.destroy();
  }
});

test('txt values are forwarded as strings and the name is trimmed', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    await mdns.startBroadcast({ name: '  Padded  ', port: 80, txt: { a: '1', b: 2 } });
    assert.equal(fake.published[0].opts.name, 'Padded');
    assert.deepEqual(fake.published[0].opts.txt, { a: '1', b: '2' });
  } finally {
    await mdns.destroy();
  }
});

// ---- discover -----------------------------------------------------------------------------

test('discover without a target collects, de-duplicates and normalizes services', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    const pending = mdns.discover({ type: '_http._tcp.', timeout: 80 });
    const browser = lastBrowser(fake);
    browser.onUp(service('A', 80, { txt: { k: Buffer.from('v'), n: 7 } }));
    browser.onUp(service('A', 80)); // duplicate (name:port)
    browser.onUp(service('A', 81)); // same name, other port: distinct
    browser.onUp({ name: 'NoPort' });

    const result = await pending;
    assert.equal(result.error, false);
    assert.equal(result.servicesFound, 3);
    assert.deepEqual(result.services.map((s) => `${s.name}:${s.port}`), ['A:80', 'A:81', 'NoPort:0']);
    assert.deepEqual(result.services[0].txt, { k: 'v', n: '7' });
    assert.equal(result.services[0].type, '_http._tcp.');
    assert.equal(result.services[0].domain, 'local.');
    assert.deepEqual(result.services[0].hosts, ['192.168.1.2']);
    assert.deepEqual(result.services[2].hosts, []);
    assert.equal(browser.stopCalls, 1, 'browser must be stopped when discovery ends');
  } finally {
    await mdns.destroy();
  }
});

test('discover with a target filters by normalized prefix and exits early', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    const started = Date.now();
    const pending = mdns.discover({ name: 'Foo', timeout: 10_000 });
    const browser = lastBrowser(fake);
    browser.onUp(service('Other', 1));
    browser.onUp(service('Foo (2)', 2));

    const result = await pending;
    assert.ok(Date.now() - started < 2000, 'should not wait for the 10s timeout');
    assert.deepEqual(result.services.map((s) => s.name), ['Foo (2)']);
    assert.equal(browser.stopCalls, 1);
  } finally {
    await mdns.destroy();
  }
});

test('discover returns what it has, flagged as error, when the browser reports an error', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    const pending = mdns.discover({ timeout: 60 });
    const browser = lastBrowser(fake);
    browser.onUp(service('A', 1));
    browser.emit('error', new Error('socket closed'));

    const result = await pending;
    assert.equal(result.error, true);
    assert.equal(result.errorMessage, 'socket closed');
    assert.equal(result.servicesFound, 1);
  } finally {
    await mdns.destroy();
  }
});

test('non-finite timeouts fall back to the default instead of ending discovery immediately', async () => {
  for (const timeout of [Infinity, NaN, '100']) {
    const fake = fakeBonjour();
    const mdns = new mDNS(fake);
    try {
      // A targeted discovery ends early on a match, so the default (3s) never has to elapse.
      const pending = mdns.discover({ name: 'Late', timeout });
      await sleep(40); // the old behaviour resolved after ~1ms with nothing found
      lastBrowser(fake).onUp(service('Late', 1));
      const result = await pending;
      assert.deepEqual(result.services.map((s) => s.name), ['Late'], `timeout=${String(timeout)}`);
    } finally {
      await mdns.destroy();
    }
  }
});

test('negative timeouts end the discovery right away', async () => {
  const mdns = new mDNS(fakeBonjour());
  try {
    const started = Date.now();
    const result = await mdns.discover({ timeout: -500 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(result.error, false);
  } finally {
    await mdns.destroy();
  }
});

// ---- lifecycle ----------------------------------------------------------------------------

test('destroy() ends in-flight discoveries instead of leaving them waiting', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);

  const pending = mdns.discover({ timeout: 30_000 });
  lastBrowser(fake).onUp(service('A', 1));
  const started = Date.now();
  await mdns.destroy();

  const result = await pending;
  assert.ok(Date.now() - started < 2000, 'must not wait for the 30s timeout');
  assert.equal(result.error, true);
  assert.match(result.errorMessage, /destroyed/);
  assert.equal(result.servicesFound, 1, 'partial results are still returned');
  assert.equal(lastBrowser(fake).stopCalls, 1);
});

test('after destroy() every call reports a shaped error and nothing is published', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  await mdns.startBroadcast({ name: 'A', port: 80 });
  await mdns.destroy();
  await mdns.destroy(); // idempotent

  assert.equal(fake.published[0].stopCalls, 1);
  assert.equal(fake.destroyed >= 1, true);

  const start = await mdns.startBroadcast({ name: 'B', port: 81 });
  assert.equal(start.error, true);
  assert.match(start.errorMessage, /destroyed/);
  const found = await mdns.discover({ timeout: 5 });
  assert.equal(found.error, true);
  assert.equal(fake.published.length, 1);
});
