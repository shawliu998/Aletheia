"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld(
  "veraDesktop",
  Object.freeze({
    getInfo: () => ipcRenderer.invoke("vera:get-desktop-info"),
    configureConnection: (appUrl) =>
      ipcRenderer.invoke("vera:configure-connection", appUrl),
    cancelConnectionSetup: () =>
      ipcRenderer.invoke("vera:cancel-connection-setup"),
  }),
);
