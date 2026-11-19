// Schmale Brücke zur Oberfläche: nur Dateidialoge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chromastack', {
  desktop: true,
  pickFile: (title) => ipcRenderer.invoke('pick-file', title),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
});
