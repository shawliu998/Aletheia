"use strict";

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  isExternalBrowserUrl,
  isSameConnectedOrigin,
  normalizeConnectedAppUrl,
} = require("./connectedConfig");
const {
  readStoredConnection,
  writeStoredConnection,
} = require("./connectedConnectionStore");

const PRODUCT_NAME = "Vera";
const DEFAULT_DEVELOPMENT_URL = "http://localhost:3002/assistant";
const SETUP_DOCUMENT_PATH = path.join(__dirname, "connectedSetup.html");
const SETUP_DOCUMENT_URL = pathToFileURL(SETUP_DOCUMENT_PATH).toString();
const TEST_AUTO_QUIT_MS = Number(process.env.VERA_TEST_AUTO_QUIT_MS ?? 0);
let mainWindow = null;
let applicationUrl = null;
let connectionSource = null;
let hasLoadedWorkspace = false;

app.setName(PRODUCT_NAME);
const explicitProfile = String(
  process.env.VERA_DESKTOP_PROFILE_DIR ?? "",
).trim();
if (explicitProfile) {
  if (!path.isAbsolute(explicitProfile)) {
    throw new Error("VERA_DESKTOP_PROFILE_DIR must be an absolute path.");
  }
  fs.mkdirSync(explicitProfile, { recursive: true, mode: 0o700 });
  const profileInfo = fs.lstatSync(explicitProfile);
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) {
    throw new Error("VERA_DESKTOP_PROFILE_DIR must be a real directory.");
  }
  app.setPath("userData", explicitProfile);
  app.setPath("sessionData", explicitProfile);
}

function configuredApplicationConnection() {
  const environmentUrl = String(process.env.VERA_APP_URL ?? "").trim();
  if (environmentUrl) {
    return {
      url: normalizeConnectedAppUrl(environmentUrl),
      source: "environment",
    };
  }
  const storedUrl = readStoredConnection(app.getPath("userData"));
  if (storedUrl) return { url: storedUrl, source: "profile" };
  if (!app.isPackaged) {
    return {
      url: normalizeConnectedAppUrl(DEFAULT_DEVELOPMENT_URL),
      source: "development-default",
    };
  }
  return null;
}

function isTrustedSetupSender(event) {
  const senderUrl = event.sender.getURL();
  return (
    senderUrl === SETUP_DOCUMENT_URL ||
    senderUrl.startsWith(`${SETUP_DOCUMENT_URL}?`)
  );
}

async function showConnectionSetup(message = "") {
  if (!mainWindow) return;
  await mainWindow.loadFile(SETUP_DOCUMENT_PATH, {
    ...(message ? { query: { error: message } } : {}),
  });
}

async function openWorkspace(url, source) {
  if (!mainWindow) return;
  applicationUrl = url;
  connectionSource = source;
  hasLoadedWorkspace = false;
  await mainWindow.loadURL(url.toString());
  hasLoadedWorkspace = true;
}

async function openExternal(candidate) {
  if (isExternalBrowserUrl(candidate)) await shell.openExternal(candidate);
}

function installNavigationBoundary(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (applicationUrl && isSameConnectedOrigin(url, applicationUrl)) {
      void window.loadURL(url);
    } else {
      void openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (applicationUrl && isSameConnectedOrigin(url, applicationUrl)) return;
    event.preventDefault();
    void openExternal(url);
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: "#f6f7f9",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 15, y: 15 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "connectedPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
    },
  });
  installNavigationBoundary(window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("did-finish-load", () => {
    console.log(
      `[vera-connected] renderer-ready origin=${applicationUrl?.origin ?? "status"}`,
    );
    if (TEST_AUTO_QUIT_MS > 0) setTimeout(() => app.quit(), TEST_AUTO_QUIT_MS);
  });
  return window;
}

function installSessionBoundary() {
  const activeSession = session.defaultSession;
  activeSession.setPermissionCheckHandler(() => false);
  activeSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  activeSession.on("will-download", async (_event, item, contents) => {
    item.pause();
    const owner = BrowserWindow.fromWebContents(contents) ?? mainWindow;
    const result = await dialog.showSaveDialog(owner, {
      title: "Save Vera document",
      defaultPath: path.basename(item.getFilename()),
    });
    if (result.canceled || !result.filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(result.filePath);
    item.resume();
  });
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: "about" },
              {
                label: "Connection Settings…",
                enabled: !String(process.env.VERA_APP_URL ?? "").trim(),
                click: () => void showConnectionSetup(),
              },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload Vera",
          accelerator: "CmdOrCtrl+R",
          click: () => void mainWindow?.reload(),
        },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("vera:get-desktop-info", () => ({
  connected: true,
  platform: process.platform,
  version: app.getVersion(),
  currentAppUrl: applicationUrl?.toString() ?? null,
  connectionSource,
  canCancelConnectionSetup: hasLoadedWorkspace,
}));

ipcMain.handle("vera:configure-connection", async (event, rawAppUrl) => {
  if (!isTrustedSetupSender(event)) {
    throw new Error("Connection settings are available only from Vera setup.");
  }
  const url = writeStoredConnection(app.getPath("userData"), rawAppUrl);
  setImmediate(() => {
    void openWorkspace(url, "profile").catch((reason) => {
      const message =
        reason instanceof Error
          ? `Vera could not open this workspace. ${reason.message}`
          : "Vera could not open this workspace.";
      void showConnectionSetup(message);
    });
  });
  return { ok: true };
});

ipcMain.handle("vera:cancel-connection-setup", async (event) => {
  if (!isTrustedSetupSender(event)) {
    throw new Error("Connection settings are available only from Vera setup.");
  }
  if (!applicationUrl || !hasLoadedWorkspace) {
    throw new Error("There is no active Vera workspace to return to.");
  }
  const url = applicationUrl;
  const source = connectionSource;
  setImmediate(() => void openWorkspace(url, source));
  return { ok: true };
});

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  installSessionBoundary();
  installMenu();
  mainWindow = createWindow();
  try {
    const configured = configuredApplicationConnection();
    if (!configured) {
      await showConnectionSetup();
      return;
    }
    await openWorkspace(configured.url, configured.source);
  } catch (error) {
    const message =
      error instanceof Error
        ? `Vera could not open this workspace. ${error.message}`
        : "Vera could not open this workspace.";
    await showConnectionSetup(message);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    if (applicationUrl) {
      void openWorkspace(applicationUrl, connectionSource);
    } else {
      void showConnectionSetup();
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
