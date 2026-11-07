/**
 * NON-CRITICAL PATH — injected into index.html as a synchronous <script> so it
 * runs before <script type="module"> (which loads @capacitor/core).
 *
 * Responsibilities:
 *   1. Preserve third-party plugin bridges already set on window.CapacitorCustomPlatform
 *      by plugins-preload.ts via contextBridge (e.g. plugins using the 'electron:' factory).
 *   2. Write window.CapacitorCustomPlatform = { name: 'electron', plugins: <preserved> }
 *      so Capacitor.getPlatform() returns 'electron' and third-party plugin bridges survive.
 *   3. Register built-in Capacitor plugin PluginHeaders so @capacitor/core routes their
 *      calls through nativePromise/nativeCallback (→ IPC) instead of falling back to the
 *      web implementation.
 *   4. Append third-party plugin headers from _CapElectron.getPluginHeaders() so plugins
 *      that do NOT use the 'electron:' factory key are also routed natively.
 *
 * Two routing paths in Capacitor 6+:
 *   a) PluginHeaders + nativePromise/nativeCallback — used by built-in @capacitor/* plugins
 *      and third-party plugins that declare PluginHeaders in their preload.
 *   b) CapacitorCustomPlatform.plugins — used by third-party plugins that register with
 *      the 'electron:' factory key in registerPlugin.
 *   Both paths must be populated; this script handles both.
 *
 * Injection:
 *   Development  — cap-electron update writes it to public/electron-init.js and
 *                  injects the <script> tag into the root index.html so the Vite
 *                  dev server serves it at /electron-init.js.
 *   Production   — cap-electron copy writes it to electron/app/ and injects the
 *                  <script> tag into app/index.html.
 */
(function () {
  var b = window._CapElectron;
  if (!b) return;

  var builtinConfig = typeof b.getBuiltinCapacitorConfig === 'function'
    ? b.getBuiltinCapacitorConfig()
    : {};
  var fileSrcConfig = typeof b.getCapacitorFileSrcConfig === 'function'
    ? b.getCapacitorFileSrcConfig()
    : {};

  // Preserve third-party plugin bridges set by plugins-preload.ts via contextBridge.
  // Must be read BEFORE we overwrite window.CapacitorCustomPlatform below.
  var prevPlugins = (window.CapacitorCustomPlatform && window.CapacitorCustomPlatform.plugins) || {};

  // Mark this as the electron platform and keep third-party bridges intact.
  window.CapacitorCustomPlatform = { name: 'electron', plugins: prevPlugins };

  // ── Build a PluginHeader entry ─────────────────────────────────────────────
  //
  // Methods list must match the ipcMain.handle registrations in *-main.ts.
  // hasEvents = true adds addListener / removeListener / removeAllListeners
  // (callback rtype) which route through nativeCallback → IPC event channels.

  function ph(name, methods, hasEvents) {
    var m = methods.map(function (n) { return { name: n, rtype: 'promise' }; });
    if (hasEvents) m = m.concat([
      { name: 'addListener',        rtype: 'callback' },
      { name: 'removeListener',     rtype: 'callback' },
      { name: 'removeAllListeners', rtype: 'callback' },
    ]);
    return { name: name, methods: m };
  }

  function collectPreferencesLocalStorage() {
    var entries = {};
    var prefixes = ['CapacitorStorage.', '_cap_'];

    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var key = window.localStorage.key(i);
        if (!key) continue;

        var shouldMigrate = prefixes.some(function (prefix) {
          return key.indexOf(prefix) === 0;
        });
        if (!shouldMigrate) continue;

        var value = window.localStorage.getItem(key);
        if (typeof value === 'string') entries[key] = value;
      }
    } catch (_err) {
      // localStorage may be unavailable for opaque origins or restrictive browser settings.
    }

    return entries;
  }

  function withPreferencesMigrationPayload(pluginName, methodName, opts) {
    if (pluginName !== 'Preferences' || methodName !== 'migrate') return opts;

    var next = opts && Object.prototype.toString.call(opts) === '[object Object]'
      ? Object.assign({}, opts)
      : {};
    next.__localStorage = collectPreferencesLocalStorage();
    return next;
  }

  function convertFileSrc(filePath) {
    if (typeof filePath !== 'string') return filePath;
    if (!fileSrcConfig || fileSrcConfig.enabled !== true || !Array.isArray(fileSrcConfig.roots)) {
      return filePath;
    }

    var normalized = filePath;
    try {
      normalized = new URL(filePath).href;
    } catch (_err) {
      return filePath;
    }

    for (var i = 0; i < fileSrcConfig.roots.length; i++) {
      var root = fileSrcConfig.roots[i];
      if (!root || typeof root.fileUrlPrefix !== 'string' || typeof root.urlPrefix !== 'string') continue;
      if (normalized.indexOf(root.fileUrlPrefix) === 0) {
        return root.urlPrefix + normalized.slice(root.fileUrlPrefix.length);
      }
    }

    return filePath;
  }

  function isPluginFailureResult(value) {
    return !!value
      && typeof value === 'object'
      && value.success === false
      && value.__capacitorElectronPluginError === true;
  }

  function pluginFailureToError(result) {
    var payload = result.error || {};
    var err = new Error(payload.message || 'Capacitor Electron plugin call failed');
    if (payload.code) err.code = payload.code;
    if (payload.platform) err.platform = payload.platform;
    if (payload.method) err.method = payload.method;
    if (payload.details !== undefined) err.details = payload.details;
    return err;
  }

  function invokePlugin(channel, opts) {
    return b.invoke(channel, opts).then(function (result) {
      // registerPlugin() marks internal failures so main can attach
      // Capacitor-style metadata without stealing legitimate plugin results
      // such as { success: false }. Marked bridge failures become rejected
      // Promises, matching window.Electron.* IPC methods.
      if (isPluginFailureResult(result)) throw pluginFailureToError(result);
      return result;
    });
  }

  // ── Built-in Capacitor plugin headers (static) ────────────────────────────

  var BUILTIN = [
    ph('App',         ['getInfo','getState','exitApp','minimizeApp','getLaunchUrl','getAppLanguage','toggleBackButtonHandler'], true),
    ph('ActionSheet', ['showActions'], false),
    ph('Dialog',      ['alert','confirm','prompt'], false),
    ph('Browser',     ['open','close'], true),
    ph('InAppBrowser', ['openInWebView','openInSystemBrowser','openInExternalBrowser','close'], true),
    ph('AppLauncher', ['canOpenUrl','openUrl'], false),
    ph('Filesystem',  [
      'checkPermissions','requestPermissions',
      'readFile','writeFile','appendFile','deleteFile',
      'mkdir','rmdir','readdir','getUri','stat',
      'rename','copy','downloadFile',
    ], false),
    ph('Preferences', ['get','set','remove','clear','keys','migrate','removeOld'], false),
    ph('Toast',       ['show'], false),
    ph('Clipboard',   ['write','read'], false),
    ph('Device',      ['getId','getInfo','getBatteryInfo','getLanguageCode','getLanguageTag'], false),
    ph('Network',     ['getStatus'], true),
    ph('FileViewer',  [
      'openDocumentFromLocalPath',
      'openDocumentFromResources',
      'openDocumentFromUrl',
      'previewMediaContentFromLocalPath',
      'previewMediaContentFromResources',
      'previewMediaContentFromUrl',
    ], false),
    ph('FileTransfer', ['downloadFile','uploadFile'], true),
    ph('PrivacyScreen', ['enable','disable','isEnabled'], false),
    ph('LocalNotifications', [
      'schedule','cancel','getPending',
      'getDeliveredNotifications','removeDeliveredNotifications','removeAllDeliveredNotifications',
      'registerActionTypes',
      'checkPermissions','requestPermissions',
      'checkExactNotificationSetting','changeExactNotificationSetting',
      'areEnabled',
      'createChannel','deleteChannel','listChannels',
    ], true),
  ];

  if (builtinConfig.preferences === false) {
    BUILTIN = BUILTIN.filter(function (p) { return p.name !== 'Preferences'; });
  }

  // ── window.Capacitor ──────────────────────────────────────────────────────
  //
  // PluginHeaders = built-in headers + third-party headers from preload.
  // nativePromise  → ipcMain.handle(`${plugin}-${method}`, opts)
  // nativeCallback → addListener/removeListener via IPC event channels

  window.Capacitor = {
    PluginHeaders:  BUILTIN.concat(b.getPluginHeaders()),
    convertFileSrc: convertFileSrc,
    nativePromise:  function (p, m, o) { return invokePlugin(p + '-' + m, withPreferencesMigrationPayload(p, m, o)); },
    nativeCallback: function (p, m, o, fn) { return b.nativeCallback(p, m, o, fn); },
  };
})();
