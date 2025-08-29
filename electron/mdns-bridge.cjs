// electron/mdns-bridge.cjs
// Usage in preload:
//   const { createMDNSAPI } = require('.../electron/mdns-bridge.cjs')
//   contextBridge.exposeInMainWorld('mDNS', createMDNSAPI({ ipcRenderer }))
//   contextBridge.exposeInMainWorld('mdns', createMDNSAPI({ ipcRenderer })) // alias
// eslint-disable-next-line no-undef
module.exports.createMDNSAPI = ({ ipcRenderer }) => {
  return {
    /**
     * Start advertising a Bonjour/mDNS service.
     * @param {{type?: string, id?: string, port: number, domain?: string, txt?: Record<string,string>}} options
     * @returns {Promise<{publishing: boolean, name: string}>}
     */
    mdnsStartBroadcast: (options) => ipcRenderer.invoke('mdns:startBroadcast', options),

    /**
     * Stop advertising (no-op if not running).
     * @returns {Promise<{publishing: boolean}>}
     */
    mdnsStopBroadcast: () => ipcRenderer.invoke('mdns:stopBroadcast'),

    /**
     * Discover services of a given type, optional normalized exact/prefix name filter.
     * @param {{type?: string, id?: string, timeoutMs?: number}} [options]
     * @returns {Promise<{services: Array<{name:string,type:string,domain:string,port:number,hosts?:string[],txt?:Record<string,string>}>}>}
     */
    mdnsDiscover: (options) => ipcRenderer.invoke('mdns:discover', options),
  }
}
