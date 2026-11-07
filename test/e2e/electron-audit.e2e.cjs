const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { Registry } = require('bonjour-service/dist/lib/registry');
const { mDNS } = require('../../.tmp/e2e-build/electron/mdns.js');

test('a failed query response does not poison publication, discovery or watching', async () => {
  let responseError;
  let instance;
  class FakeBonjour {
    constructor(_, onError) {
      responseError = onError;
      instance = this;
      this.server = { mdns: new EventEmitter() };
      this.browsers = [];
    }
    find(_, onUp) {
      const browser = Object.assign(new EventEmitter(), { onUp, stopCalls: 0, stop() { this.stopCalls++; } });
      this.browsers.push(browser);
      return browser;
    }
    publish(options) {
      const service = Object.assign(new EventEmitter(), options, { stop: cb => cb() });
      setImmediate(() => service.emit('up'));
      return service;
    }
    destroy() {}
  }
  const exports = {};
  const warnings = [];
  vm.runInNewContext(readFileSync(require.resolve('../../.tmp/e2e-build/electron/mdns.js'), 'utf8'), {
    exports, require: name => name === 'bonjour-service' ? FakeBonjour : require(name),
    Error, Buffer, URL, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { warn: (...args) => warnings.push(args) },
  });
  const mdns = new exports.mDNS();
  const errors = [];
  mdns.on('watchError', error => errors.push(error));
  try {
    await mdns.watchServices({ types: ['_http._tcp.'] });
    const pending = mdns.discover({ name: 'Peer', timeout: 200 });
    responseError(Object.assign(new Error('send EHOSTUNREACH'), { code: 'EHOSTUNREACH' }));
    instance.browsers[1].onUp({ name: 'Peer', port: 80, addresses: ['192.168.1.8'] });
    assert.equal((await pending).error, false);
    assert.equal(instance.browsers[0].stopCalls, 0);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal((await mdns.startBroadcast({ name: 'Working', port: 80 })).error, false);
    assert.equal((await mdns.discover({ timeout: 1 })).error, false);
    assert.equal((await mdns.watchServices({ types: ['_ipp._tcp.'] })).error, false);
  } finally { await mdns.destroy(); }
});

function registryRig(conflict) {
  const transport = new EventEmitter();
  const packets = [];
  transport.query = (name, _, cb) => {
    cb();
    setImmediate(() => transport.emit('response', { answers: [{ name }], additionals: [] }));
  };
  transport.respond = (records, cb) => { packets.push(records); setImmediate(cb); };
  const registry = new Registry({ mdns: transport, register() {}, unregister() {} });
  const mdns = new mDNS({
    server: { mdns: transport },
    publish: options => registry.publish({ ...options, probe: conflict }),
    destroy: () => registry.destroy(),
  }, { publishTimeoutMs: 2000 });
  return { mdns, registry, packets };
}

test('the real Bonjour registry rejects a conflicting name promptly without a goodbye or retained service', async () => {
  const { mdns, registry, packets } = registryRig(true);
  let timer;
  try {
    const result = await Promise.race([
      mdns.startBroadcast({ name: 'Taken', port: 80 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Conflict waited for publish timeout')), 700); }),
    ]);
    assert.equal(result.error, true);
    assert.equal(result.publishing, false);
    assert.match(result.errorMessage, /name.*in use/i);
    assert.equal(packets.length, 0, 'an unpublished service must never send goodbye records');
    assert.equal(registry.services.length, 0);
  } finally { clearTimeout(timer); await mdns.destroy(); }
});

test('stopping an announced Bonjour service still sends goodbye records', async () => {
  const { mdns, registry, packets } = registryRig(false);
  try {
    assert.equal((await mdns.startBroadcast({ name: 'Working', port: 80 })).error, false);
    assert.ok(packets[0].every(record => record.ttl > 0));
    assert.equal((await mdns.stopBroadcast()).error, false);
    assert.ok(packets[1].every(record => record.ttl === 0));
    assert.equal(registry.services.length, 0);
  } finally { await mdns.destroy(); }
});

test('publish timeout sends goodbye for an announcement awaiting its send callback and blocks late reannouncement', async () => {
  const transport = new EventEmitter();
  const packets = [];
  let completeAnnouncement;
  let publishedService;
  let didAnnounce;
  const announced = new Promise(resolve => { didAnnounce = resolve; });
  transport.respond = (records, cb) => {
    packets.push(records);
    if (records.some(record => record.ttl > 0)) {
      completeAnnouncement = cb;
      didAnnounce();
    } else setImmediate(cb);
  };
  const registrations = [];
  const registry = new Registry({
    mdns: transport,
    register: records => registrations.push(records),
    unregister() {},
  });
  registry.probe = (_, service, done) => setImmediate(() => done(false));
  const mdns = new mDNS({
    server: { mdns: transport },
    publish(options) { publishedService = registry.publish(options); return publishedService; },
    destroy: () => registry.destroy(),
  }, { publishTimeoutMs: 40 });
  try {
    const pending = mdns.startBroadcast({ name: 'AwaitingSend', port: 80 });
    await announced;
    assert.equal(publishedService.published, false);
    const result = await pending;
    assert.equal(result.error, true);
    assert.match(result.errorMessage, /Timed out waiting for service publish/);
    assert.equal(result.publishing, false);
    assert.equal(packets.length, 2, 'a possibly announced service must send goodbye even before up');
    assert.ok(packets[1].every(record => record.ttl === 0));
    assert.equal(registry.services.length, 0);
    completeAnnouncement();
    assert.equal(publishedService.destroyed, true, 'a late send callback must not schedule new announcements');
    registry.announce(registry.server, publishedService);
    assert.deepEqual(registrations[1], [], 'late probe completion must not restore stopped records');
    assert.equal(packets.length, 2);
  } finally { await mdns.destroy(); }
});

test('discovery and watch snapshots prefer IPv4, including addresses received after the service', async () => {
  const transport = new EventEmitter();
  const browsers = [];
  const mdns = new mDNS({
    server: { mdns: transport },
    find(_, onUp) {
      const browser = Object.assign(new EventEmitter(), { onUp, stop() {} });
      browsers.push(browser);
      return browser;
    }, destroy() {},
  });
  const addresses = ['fe80::1%7', '192.168.1.8', '2001:db8::1', '192.168.1.8', 'fe80::1%7'];
  const service = { name: 'Peer', port: 80, host: 'peer.local', addresses };
  const records = [{ name: 'peer.local', type: 'A', ttl: 120, data: '192.168.1.9' }];
  const found = [], lost = [];
  mdns.on('serviceFound', event => found.push(event.service));
  mdns.on('serviceLost', event => lost.push(event.service));
  try {
    const pending = mdns.discover({ timeout: 30 });
    browsers[0].onUp({ ...service, addresses: ['fe80::1%7', 'fe80::1%7'] });
    transport.emit('response', { answers: records });
    assert.deepEqual((await pending).services[0].hosts, ['192.168.1.9', 'fe80::1%7']);
    await mdns.watchServices({ types: ['_http._tcp.'] });
    browsers[1].onUp(service);
    assert.deepEqual(found[0].hosts, ['192.168.1.8', 'fe80::1%7', '2001:db8::1']);
    transport.emit('response', { answers: records });
    browsers[1].emit('down', service);
    assert.deepEqual(lost[0].hosts, ['192.168.1.8', '192.168.1.9', 'fe80::1%7', '2001:db8::1']);
    assert.deepEqual(addresses, ['fe80::1%7', '192.168.1.8', '2001:db8::1', '192.168.1.8', 'fe80::1%7']);
  } finally { await mdns.destroy(); }
});
