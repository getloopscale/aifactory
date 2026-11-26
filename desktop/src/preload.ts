import { contextBridge, ipcRenderer } from 'electron'

// Loaded only by the local address window, never by the panel's.
contextBridge.exposeInMainWorld('connect', {
  check: (address: string) => ipcRenderer.invoke('address:check', address),
  current: () => ipcRenderer.invoke('address:current'),
})
