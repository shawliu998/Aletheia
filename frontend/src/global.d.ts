declare module "*.css";

interface AletheiaDesktopInfo {
    appVersion: string;
    backendUrl: string;
    frontendUrl: string;
    dataDir: string;
    logsDir: string;
    localClient: boolean;
}

interface Window {
    aletheiaDesktop?: {
        getInfo: () => Promise<AletheiaDesktopInfo>;
        openDataDirectory: () => Promise<{ opened: true }>;
        openLogsDirectory: () => Promise<{ opened: true }>;
        restartLocalServices: () => Promise<{ restarted: true }>;
    };
}
