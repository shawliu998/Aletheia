export const OFFICE_DIALOG_OPEN_TIMEOUT_MS = 9_000;

export interface OfficeDialogOptions {
    height: number;
    width: number;
    displayInIframe: boolean;
}

export interface OfficeDialogAsyncResult<TDialog> {
    status?: unknown;
    value?: TDialog;
    error?: { message?: string };
}

export interface OfficeDialogUi<TDialog> {
    displayDialogAsync?: (
        url: string,
        options: OfficeDialogOptions,
        callback: (result: OfficeDialogAsyncResult<TDialog>) => void,
    ) => void;
}

export interface OfficeDialogChildUi {
    messageParent?: (
        message: string,
        options?: { targetOrigin?: string },
    ) => void;
}

export interface OfficeReadyRuntime {
    onReady?: () => Promise<unknown>;
}

/** Keep the Office runtime receiver while waiting for host initialization. */
export async function readyOfficeRuntime(
    runtime: OfficeReadyRuntime | undefined,
): Promise<unknown> {
    return runtime?.onReady?.call(runtime);
}

/**
 * Office.js UI methods read their host object through `this`. Keeping that
 * receiver avoids a silent no-callback failure in Word WebView hosts.
 */
export function displayOfficeDialog<TDialog>(
    ui: OfficeDialogUi<TDialog> | undefined,
    url: string,
    options: OfficeDialogOptions,
    callback: (result: OfficeDialogAsyncResult<TDialog>) => void,
) {
    const displayDialogAsync = ui?.displayDialogAsync;
    if (!displayDialogAsync || !ui) {
        throw new Error(
            "Office sign-in is unavailable in this host. Open Vera in a supported Word desktop client.",
        );
    }
    displayDialogAsync.call(ui, url, options, callback);
}

/** Preserve the Office dialog UI receiver when sending the session result home. */
export function messageOfficeTaskPane(
    ui: OfficeDialogChildUi | undefined,
    message: string,
    options?: { targetOrigin?: string },
) {
    const messageParent = ui?.messageParent;
    if (!messageParent || !ui) {
        throw new Error("Open this sign-in page from the Vera add-in in Word.");
    }
    messageParent.call(ui, message, options);
}
