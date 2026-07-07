const { contextBridge, ipcRenderer } = require("electron");
// THIS IS IMPORTANT FOR PLUGIN!
const {createMDNSAPI} = require("@devioarts/capacitor-mdns/electron/mdns-bridge.cjs");


window.addEventListener('DOMContentLoaded', () => {
    console.log('Electron preload loaded');
});

// THIS IS IMPORTANT FOR PLUGIN!
contextBridge.exposeInMainWorld('mDNS', createMDNSAPI({ ipcRenderer }));
contextBridge.exposeInMainWorld('mdns', createMDNSAPI({ ipcRenderer })) // alias






