const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aletheiaDesktop", {
  getInfo: () => ipcRenderer.invoke("aletheia:get-info"),
  openDataDirectory: () => ipcRenderer.invoke("aletheia:open-data-directory"),
  openLogsDirectory: () => ipcRenderer.invoke("aletheia:open-logs-directory"),
  restartLocalServices: () => ipcRenderer.invoke("aletheia:restart-local-services"),
});
