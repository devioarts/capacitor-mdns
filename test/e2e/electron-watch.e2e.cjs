const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const Bonjour = require('bonjour-service');
const { mDNS } = require('../../.tmp/e2e-build/electron/mdns.js');
const { mDNSWeb } = require('../../.tmp/e2e-build/src/web.js');
const { pluginSettings } = require('../../.tmp/e2e-build/electron/src/plugin-settings.js');
const { createMDNSAPI } = require('../../electron/mdns-bridge.cjs');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function fakeBonjour() {
  const transport = new EventEmitter();
  const browsers = [];
  const fake = {
    server: { mdns: transport }, browsers,
    find(options, onUp) {
      const browser = new EventEmitter();
      browser.options = options;
      browser.onUp = onUp;
      browser.stopCalls = 0;
      browser.stop = () => { browser.stopCalls++; };
      browsers.push(browser);
      return browser;
    },
    publish(options) {
      const service = new EventEmitter();
      service.name = options.name;
      service.stop = cb => cb?.();
      setImmediate(() => service.emit('up'));
      return service;
    },
    destroy() {},
  };
  return fake;
}

const service = (name, extra = {}) => ({ name, port: 80, addresses: ['10.1.2.3'], host: 'test.local', ...extra });

test('watch validates before replacing, deduplicates types and emits complete snapshots', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  const found = [], lost = [];
  mdns.on('serviceFound', e => found.push(e.service));
  mdns.on('serviceLost', e => lost.push(e.service));
  try {
    assert.equal((await mdns.watchServices({ types: [' _http._tcp', '_http._tcp.', '_ipp._tcp.'] })).watchersStarted, 2);
    const browser = fake.browsers[0];
    for (const options of [null, {}, { types: [] }, { types: [' '] }, { types: [7] }, { types: ['http'] }]) {
      assert.equal((await mdns.watchServices(options)).error, true);
    }
    assert.equal(browser.stopCalls, 0);
    browser.onUp(service('A', { txt: { role: 'test' } }));
    browser.onUp(service('A', { txt: { role: 'updated' } }));
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].hosts, ['10.1.2.3']);
    browser.emit('down', service('A'));
    assert.equal(lost.length, 1);
    assert.deepEqual(lost[0], { ...found[0], txt: { role: 'updated' } });
    browser.emit('down', service('Unknown'));
    assert.equal(lost.length, 1);
  } finally { await mdns.destroy(); }
});

test('watch stop and replacement ignore old callbacks without stopping broadcast or discovery', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  const found = [];
  mdns.on('serviceFound', e => found.push(e));
  try {
    await mdns.startBroadcast({ name: 'Published', port: 80 });
    await mdns.watchServices({ types: ['_http._tcp.'] });
    const old = fake.browsers[0];
    const discovery = mdns.discover({ type: '_ipp._tcp.', timeout: 10 });
    const once = fake.browsers[1];
    await mdns.watchServices({ types: ['_ipp._tcp.'] });
    old.onUp(service('Stale'));
    old.emit('down', service('Stale'));
    assert.deepEqual(await mdns.stopWatching(), { watching: false, error: false, errorMessage: null });
    fake.browsers[2].onUp(service('AfterStop'));
    once.onUp(service('Once'));
    assert.equal((await discovery).servicesFound, 1);
    assert.equal(found.length, 0);
    assert.ok(mdns.advertiser);
    assert.equal((await mdns.stopWatching()).error, false);
    await mdns.destroy();
    assert.equal((await mdns.watchServices({ types: ['_http._tcp.'] })).error, true);
  } finally { if (!mdns.destroyed) await mdns.destroy(); }
});

test('failed watch cleanup is reported and retried; partial startup cleans all browsers', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  try {
    await mdns.watchServices({ types: ['_http._tcp.'] });
    const first = fake.browsers[0];
    first.stop = () => { throw new Error('stop failed'); };
    assert.match((await mdns.stopWatching()).errorMessage, /stop failed/);
    assert.equal((await mdns.watchServices({ types: ['_ipp._tcp.'] })).error, true);
    first.stop = () => { first.stopCalls++; };
    assert.equal((await mdns.stopWatching()).error, false);
    const originalFind = fake.find;
    fake.find = (opts, cb) => {
      if (opts.type === 'ipp') throw new Error('find failed');
      return originalFind(opts, cb);
    };
    const result = await mdns.watchServices({ types: ['_http._tcp.', '_ipp._tcp.'] });
    assert.equal(result.error, true);
    assert.match(result.errorMessage, /find failed/);
    assert.equal(fake.browsers[1].stopCalls, 1);
  } finally { await mdns.destroy(); }
});

test('socket errors stop the watcher and are delivered as watchError', async () => {
  const fake = fakeBonjour();
  const mdns = new mDNS(fake);
  const errors = [];
  mdns.on('watchError', error => errors.push(error));
  try {
    await mdns.watchServices({ types: ['_http._tcp.'] });
    fake.server.mdns.emit('error', new Error('EACCES'));
    assert.deepEqual(errors, [{ type: '_http._tcp.', errorMessage: 'EACCES', watching: false }]);
    assert.equal(fake.browsers[0].stopCalls, 1);
    assert.equal((await mdns.watchServices({ types: ['_http._tcp.'] })).error, true);
    assert.equal((await mdns.discover()).error, true);
  } finally { await mdns.destroy(); }
});

test('real Bonjour browser handles late addresses, refreshes TTL, expires and rediscovers', async () => {
  const transport = new EventEmitter();
  const queries = [];
  transport.query = (...args) => queries.push(args);
  const mdns = new mDNS({ server: { mdns: transport }, find: (opts, cb) => new Bonjour.Browser(transport, opts, cb), destroy() {} });
  const found = [], lost = [];
  mdns.on('serviceFound', e => found.push(e.service));
  mdns.on('serviceLost', e => lost.push(e.service));
  const packet = (ttl = 1) => ({ answers: [
    { name: '_http._tcp.local', type: 'PTR', ttl, data: 'native.app._http._tcp.local' },
    { name: 'native.app._http._tcp.local', type: 'SRV', ttl, data: { target: 'test.local', port: 80 } },
  ], additionals: [] });
  try {
    await mdns.watchServices({ types: ['_http._tcp.'] });
    const discovery = mdns.discover({ type: '_http._tcp.', name: 'native.app', timeout: 50 });
    transport.emit('response', packet(), {});
    assert.equal((await discovery).servicesFound, 0);
    assert.equal(found.length, 0, 'wait for a usable address before announcing a service');
    assert.ok(queries.some(([name, type]) => name === 'test.local' && type === 'A'));
    assert.ok(queries.some(([name, type]) => name === 'test.local' && type === 'AAAA'));
    transport.emit('response', { answers: [{ name: 'test.local', type: 'A', ttl: 120, data: '10.1.2.3' }], additionals: [] }, {});
    assert.equal(found[0].name, 'native.app');
    assert.deepEqual(found[0].hosts, ['10.1.2.3']);
    await sleep(650);
    transport.emit('response', packet(), {});
    await sleep(500);
    assert.equal(lost.length, 0, 'an active service must not expire using its original timestamp');
    await sleep(1000);
    assert.equal(lost.length, 1);
    assert.deepEqual(lost[0].hosts, ['10.1.2.3']);
    transport.emit('response', { ...packet(), additionals: [{ name: 'test.local', type: 'A', ttl: 120, data: '10.1.2.3' }] }, {});
    assert.equal(found.length, 2);
    transport.emit('response', packet(0), {});
    assert.equal(lost.length, 2);
  } finally { await mdns.destroy(); }
});

test('manual bridge forwards events, removes only its subscriptions and web proxy receives them', async () => {
  const ipc = new EventEmitter();
  const invokes = [];
  ipc.invoke = async (...args) => { invokes.push(args); return { watching: false, error: false, errorMessage: null }; };
  const api = createMDNSAPI({ ipcRenderer: ipc });
  const outside = () => {};
  ipc.on('mdns:event:serviceFound', outside);
  global.window = { mDNS: api };
  try {
    const web = new mDNSWeb();
    const received = [];
    const subscription = await web.addListener('serviceFound', event => received.push(event));
    ipc.emit('mdns:event:serviceFound', { sender: 'must not leak' }, { service: { name: 'A' } });
    assert.deepEqual(received, [{ service: { name: 'A' } }]);
    await subscription.remove();
    await web.addListener('serviceLost', () => {});
    await web.removeAllListeners();
    assert.equal(ipc.listenerCount('mdns:event:serviceFound'), 1);
    assert.equal(ipc.listenerCount('mdns:event:serviceLost'), 0);
    await web.watchServices({ types: ['_http._tcp.'] });
    await web.stopWatching();
    assert.deepEqual(invokes.map(call => call[0]), ['mdns:watchServices', 'mdns:stopWatching']);
  } finally { delete global.window; }
  assert.equal((await new mDNSWeb().watchServices({ types: ['_http._tcp.'] })).error, true);
});

test('Electron metadata and both IPC routes expose the watcher methods and event channels', async () => {
  const handlers = new Map();
  const sent = [];
  const window = url => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, getURL: () => url, send: (...args) => sent.push(args) } });
  const electron = {
    app: { isPackaged: false, getAppPath: () => '/app' },
    ipcMain: { removeHandler: key => handlers.delete(key), handle: (key, fn) => handlers.set(key, fn) },
    BrowserWindow: { getAllWindows: () => [window('capacitor-electron://localhost/index.html'), window('https://attacker.example/'), window('file:///outside/index.html')] },
  };
  const exports = {};
  vm.runInNewContext(readFileSync(require.resolve('../../.tmp/e2e-build/electron/mdns.js'), 'utf8'), {
    exports, require: name => name === 'electron' ? electron : require(name),
    console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, structuredClone, URL,
  });
  const fake = fakeBonjour();
  const mdns = new exports.mDNS(fake, { trustedOrigins: ['http://127.0.0.1:5173'] });
  try {
    mdns.init();
    const frame = { url: 'capacitor-electron://localhost/index.html' };
    const trusted = { senderFrame: frame, sender: { mainFrame: frame } };
    for (const [channel, handler] of handlers) {
      assert.throws(() => handler({}, {}), /Untrusted/, channel);
      const remote = { url: 'https://attacker.example/' };
      assert.throws(() => handler({ senderFrame: remote, sender: { mainFrame: remote } }, {}), /Untrusted/, channel);
      assert.throws(() => handler({ senderFrame: frame, sender: { mainFrame: {} } }, {}), /Untrusted/, channel);
    }
    for (const url of ['file:///app/index.html', 'http://localhost:5173/', 'http://127.0.0.1:5173/']) {
      const frame = { url };
      assert.equal((await handlers.get('mdns:getPluginPlatform')({ senderFrame: frame, sender: { mainFrame: frame } })).platform, 'electron');
    }
    for (const url of ['file:///app-evil/index.html', 'file:///outside/index.html', 'http://localhost:5174/', 'capacitor-electron://localhost.evil/', 'capacitor-electron://localhost:123/']) {
      const frame = { url };
      assert.throws(() => handlers.get('mdns:getPluginPlatform')({ senderFrame: frame, sender: { mainFrame: frame } }), /Untrusted/, url);
    }
    electron.app.isPackaged = true;
    const devFrame = { url: 'http://localhost:5173/' };
    assert.throws(() => handlers.get('mdns:getPluginPlatform')({ senderFrame: devFrame, sender: { mainFrame: devFrame } }), /Untrusted/);
    electron.app.isPackaged = false;
    assert.equal((await handlers.get('mdns:watchServices')(trusted, { types: ['_http._tcp.'] })).watchersStarted, 1);
    fake.browsers[0].onUp(service('A'));
    assert.deepEqual(sent.map(args => args[0]), ['event-mDNS-serviceFound', 'mdns:event:serviceFound']);
    assert.ok(pluginSettings.pluginMethods.includes('watchServices'));
    assert.ok(pluginSettings.pluginMethods.includes('stopWatching'));
    assert.deepEqual(pluginSettings.pluginEvents, ['serviceFound', 'serviceLost', 'watchError']);
    await handlers.get('mdns:stopWatching')(trusted);
  } finally { await mdns.destroy(); }
  assert.equal(handlers.size, 0);
});
