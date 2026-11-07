const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

test('invalid timeouts never cross the JSON bridge or replace an existing search', async () => {
  const calls = [];
  const platform = {
    discover: async options => { calls.push(JSON.parse(JSON.stringify(options))); return { error: false, errorMessage: null, servicesFound: 0, services: [] }; },
    stopWatching: () => Promise.resolve({ watching: false }),
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/index.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => name === '@capacitor/core' ? { registerPlugin: () => platform } : {} });
  for (const timeout of [NaN, Infinity, -Infinity, '50']) {
    const result = await exports.mDNS.discover({ timeout });
    assert.equal(result.error, true);
    assert.equal(result.errorMessage, 'Invalid timeout');
    assert.equal(result.servicesFound, 0);
  }
  assert.equal(calls.length, 0);
  await exports.mDNS.discover({ timeout: 50 });
  assert.deepEqual(calls, [{ timeout: 50 }]);
  assert.equal(exports.mDNS.stopWatching, platform.stopWatching);
});

test('missing Electron registration reports the regeneration step for both incomplete runtime shapes', async () => {
  for (const runtime of [{ name: 'electron' }, { name: 'electron', plugins: {} }]) {
    let loader;
    const exports = {};
    const code = ts.transpileModule(readFileSync('src/index.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, {
      exports, window: { CapacitorCustomPlatform: runtime },
      require: name => name === '@capacitor/core' ? { registerPlugin: (_, implementations) => {
        loader = implementations.electron;
        return { discover: options => Promise.resolve().then(loader).then(plugin => plugin.discover(options)) };
      } } : {},
    });
    await assert.rejects(exports.mDNS.discover(), /mDNS Electron plugin is not registered; run npx cap-electron sync/);
    const platform = { discover: async () => ({ error: false }) };
    runtime.plugins = { mDNS: platform };
    assert.equal(await loader(), platform);
    assert.equal((await exports.mDNS.discover()).error, false);
  }
});
