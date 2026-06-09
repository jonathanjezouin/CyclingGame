const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  slmGenerate: (payload) => ipcRenderer.invoke('slm:generate', payload),
})
