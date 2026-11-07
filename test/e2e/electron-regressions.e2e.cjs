const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const Bonjour = require('bonjour-service');
const { mDNS } = require('../../.tmp/e2e-build/electron/mdns.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function rig(realBrowser = false) {
  const transport = new EventEmitter();
  transport.query = () => {};
  const fake = {
    server: { mdns: transport }, services: [], browsers: [],
    publish(opts) {
      const svc = Object.assign(new EventEmitter(), opts, { activated: true, stop(cb) { this.activated = false; setImmediate(() => cb?.()); } });
      this.services.push(svc); return svc;
    },
    find(opts, up) {
      const browser = realBrowser ? new Bonjour.Browser(transport, opts, up) : Object.assign(new EventEmitter(), { stop() {}, onUp: up });
      this.browsers.push(browser); return browser;
    }, destroy() {},
  };
  return { fake, transport, mdns: new mDNS(fake, { publishTimeoutMs: 80, stopTimeoutMs: 40 }) };
}
test('transport failure settles pending publication and ignores late up', async () => {
  const { fake, transport, mdns } = rig();
  try {
    const pending = mdns.startBroadcast({ name: 'Test', port: 80 });
    await tick(); transport.emit('error', new Error('socket failed')); fake.services[0].emit('up');
    const result = await pending;
    assert.equal(result.error, true); assert.match(result.errorMessage, /socket failed/);
  } finally { await mdns.destroy(); }
});
test('discover waits for late A records and matches dotted names without changing the returned name', async () => {
  const { transport, mdns } = rig(true);
  try {
    let done = false;
    const pending = mdns.discover({ name: 'My-Device', timeout: 150 });
    pending.then(() => { done = true; });
    transport.emit('response', { answers: [
      { name: '_http._tcp.local', type: 'PTR', ttl: 120, data: 'My.Device._http._tcp.local' },
      { name: 'My.Device._http._tcp.local', type: 'SRV', ttl: 120, data: { port: 80, target: 'device.local' } },
    ], additionals: [] });
    await tick(); assert.equal(done, false);
    transport.emit('response', { answers: [{ name: 'device.local', type: 'A', ttl: 120, data: '192.168.1.8' }], additionals: [] });
    const result = await pending;
    assert.deepEqual(result.services.map(s => [s.name, s.hosts]), [['My.Device', ['192.168.1.8']]]);
  } finally { await mdns.destroy(); }
});
test('a new valid discover replaces its predecessor, but invalid input preserves it', async () => {
  const { mdns } = rig();
  try {
    const first = mdns.discover({ timeout: 500 });
    assert.equal((await mdns.discover({ type: 'bad' })).error, true);
    const second = mdns.discover({ timeout: 5 });
    assert.match((await first).errorMessage, /replaced/i);
    assert.equal((await second).error, false);
  } finally { await mdns.destroy(); }
});
test('invalid UTF-8 name and TXT input never stops a running advertisement', async () => {
  const { fake, mdns } = rig();
  try {
    const first = mdns.startBroadcast({ name: 'Good', port: 80 }); await tick(); fake.services[0].emit('up'); await first;
    for (const options of [
      { name: 'é'.repeat(32) }, { txt: { '': 'x' } }, { txt: { 'a=b': 'x' } },
      { txt: { a: 'é'.repeat(127) } }, { txt: { a: 2 } }, { txt: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, 'x'.repeat(250)])) }, { txt: { A: '', a: '' } },
      { type: '_123._tcp.' }, { type: '_ab--cd._tcp.' }, { type: '_abcdefghijklmnop._tcp.' },
    ]) {
      assert.equal((await mdns.startBroadcast({ name: 'Bad', port: 81, ...options })).error, true, JSON.stringify(options));
      assert.equal(fake.services[0].activated, true);
    }
  } finally { await mdns.destroy(); }
});
test('a publisher deactivated by a name conflict reports the cause', async () => {
  const { fake, mdns } = rig();
  try {
    const pending = mdns.startBroadcast({ name: 'Taken', port: 80 }); await tick(); fake.services[0].activated = false;
    const result = await pending; assert.equal(result.error, true); assert.match(result.errorMessage, /name.*in use/i);
  } finally { await mdns.destroy(); }
});
