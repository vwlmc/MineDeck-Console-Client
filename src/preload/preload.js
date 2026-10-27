'use strict'
// The only bridge between the sandboxed window and MineDeck's main process.
// The window can call named functions (validated in main.js) and listen for
// events. It has no access to Node.js, the file system or account tokens.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('minedeck', {
  call: (method, ...args) => ipcRenderer.invoke('minedeck:call', method, args),
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message)
    ipcRenderer.on('minedeck:evt', handler)
    return () => ipcRenderer.removeListener('minedeck:evt', handler)
  }
})
