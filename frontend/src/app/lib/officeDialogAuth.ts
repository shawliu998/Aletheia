import type { Session } from "@supabase/supabase-js";

export const OFFICE_AUTH_MESSAGE_TYPE = "vera.office.auth";
export const OFFICE_AUTH_MESSAGE_VERSION = 1;

const NONCE_PATTERN = /^[a-f0-9]{32,128}$/;

export type OfficeAuthDialogMessage =
    | {
          type: typeof OFFICE_AUTH_MESSAGE_TYPE;
          version: typeof OFFICE_AUTH_MESSAGE_VERSION;
          nonce: string;
          status: "success";
          accessToken: string;
          refreshToken: string;
      }
    | {
          type: typeof OFFICE_AUTH_MESSAGE_TYPE;
          version: typeof OFFICE_AUTH_MESSAGE_VERSION;
          nonce: string;
          status: "error" | "cancelled";
          message?: string;
      };

export function createOfficeAuthNonce(): string {
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

export function isValidOfficeAuthNonce(value: string | null): value is string {
    return !!value && NONCE_PATTERN.test(value);
}

export function buildOfficeAuthDialogUrl(
    origin: string,
    nonce: string,
): string {
    if (!isValidOfficeAuthNonce(nonce)) {
        throw new Error("Vera could not start a secure sign-in session.");
    }
    const url = new URL("/office/auth/dialog", origin);
    url.searchParams.set("nonce", nonce);
    return url.toString();
}

export function createOfficeAuthSuccessMessage(
    nonce: string,
    session: Pick<Session, "access_token" | "refresh_token">,
): OfficeAuthDialogMessage {
    if (!isValidOfficeAuthNonce(nonce)) {
        throw new Error("The Office sign-in session is invalid.");
    }
    if (!session.access_token || !session.refresh_token) {
        throw new Error("Vera did not return a renewable session.");
    }
    return {
        type: OFFICE_AUTH_MESSAGE_TYPE,
        version: OFFICE_AUTH_MESSAGE_VERSION,
        nonce,
        status: "success",
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
    };
}

export function createOfficeAuthStatusMessage(
    nonce: string,
    status: "error" | "cancelled",
    message?: string,
): OfficeAuthDialogMessage {
    if (!isValidOfficeAuthNonce(nonce)) {
        throw new Error("The Office sign-in session is invalid.");
    }
    return {
        type: OFFICE_AUTH_MESSAGE_TYPE,
        version: OFFICE_AUTH_MESSAGE_VERSION,
        nonce,
        status,
        ...(message ? { message } : {}),
    };
}

export function parseOfficeAuthDialogMessage(
    value: unknown,
    expectedNonce: string,
): OfficeAuthDialogMessage {
    if (!isValidOfficeAuthNonce(expectedNonce)) {
        throw new Error("The Office sign-in session is invalid.");
    }

    let parsed: unknown = value;
    if (typeof value === "string") {
        try {
            parsed = JSON.parse(value);
        } catch {
            throw new Error("Vera received an invalid sign-in response.");
        }
    }

    if (!parsed || typeof parsed !== "object") {
        throw new Error("Vera received an invalid sign-in response.");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
        candidate.type !== OFFICE_AUTH_MESSAGE_TYPE ||
        candidate.version !== OFFICE_AUTH_MESSAGE_VERSION ||
        candidate.nonce !== expectedNonce
    ) {
        throw new Error("Vera rejected an unexpected sign-in response.");
    }

    if (candidate.status === "success") {
        if (
            typeof candidate.accessToken !== "string" ||
            !candidate.accessToken ||
            typeof candidate.refreshToken !== "string" ||
            !candidate.refreshToken
        ) {
            throw new Error("Vera received an incomplete sign-in session.");
        }
        return candidate as OfficeAuthDialogMessage;
    }

    if (candidate.status === "error" || candidate.status === "cancelled") {
        if (
            candidate.message !== undefined &&
            typeof candidate.message !== "string"
        ) {
            throw new Error("Vera received an invalid sign-in response.");
        }
        return candidate as OfficeAuthDialogMessage;
    }

    throw new Error("Vera received an invalid sign-in response.");
}
