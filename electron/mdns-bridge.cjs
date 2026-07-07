// electron/mdns-bridge.cjs
// Usage in preload:
//   const { createMDNSAPI } = require('.../electron/mdns-bridge.cjs')
//   contextBridge.exposeInMainWorld('mDNS', createMDNSAPI({ ipcRenderer }))
//   contextBridge.exposeInMainWorld('mdns', createMDNSAPI({ ipcRenderer })) // alias
module.exports.createMDNSAPI = ({ ipcRenderer }) => {
  return {
    /**
     * Start advertising a Bonjour/mDNS service.
     * @param {{type?: string, name: string, port: number, txt?: Record<string,string>}} options
     * @returns {Promise<{publishing: boolean, name: string, error: boolean, errorMessage: string|null}>}
     */
    startBroadcast: (options) => ipcRenderer.invoke('mdns:startBroadcast', options),

    /**
     * Stop advertising (no-op if not running).
     * @returns {Promise<{publishing: boolean}>}
     */
    stopBroadcast: () => ipcRenderer.invoke('mdns:stopBroadcast'),

    /**
     * Discover services of a given type, optional normalized exact/prefix name filter.
     * BUG [critical]: JSDoc documents `id` and `timeoutMs` but the actual TypeScript
     * implementation (mdns.ts) reads `options.name` and `options.timeout`.
     * Passing `id`/`timeoutMs` here will be silently ignored; use `name`/`timeout` instead.
     * @param {{type?: string, name?: string, timeout?: number}} [options]
     * @returns {Promise<{services: Array<{name:string,type:string,domain:string,port:number,hosts?:string[],txt?:Record<string,string>}>}>}
     */
    discover: (options) => ipcRenderer.invoke('mdns:discover', options),
  }
}
