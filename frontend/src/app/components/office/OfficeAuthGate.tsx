"use client";

import Script from "next/script";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2, LogIn } from "lucide-react";
import {
    useEffect,
    useRef,
    useState,
    type FormEvent,
    type ReactNode,
} from "react";
import { SiteLogo } from "@/app/components/site-logo";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    buildOfficeAuthDialogUrl,
    createOfficeAuthNonce,
    parseOfficeAuthDialogMessage,
} from "@/app/lib/officeDialogAuth";
import {
    displayOfficeDialog,
    OFFICE_DIALOG_OPEN_TIMEOUT_MS,
    readyOfficeRuntime,
    type OfficeDialogUi,
} from "@/app/lib/officeDialogRuntime";
import { supabase } from "@/app/lib/supabase";

interface OfficeDialogMessageEvent {
    message?: string;
    origin?: string;
}

interface OfficeDialogEvent {
    error?: number;
}

interface OfficeDialog {
    addEventHandler: (
        eventType: unknown,
        handler: (event: OfficeDialogMessageEvent | OfficeDialogEvent) => void,
    ) => void;
    close: () => void;
}

interface OfficeDialogRuntime {
    onReady?: () => Promise<unknown>;
    context?: {
        ui?: OfficeDialogUi<OfficeDialog>;
    };
    AsyncResultStatus?: { Succeeded?: unknown };
    EventType?: {
        DialogMessageReceived?: unknown;
        DialogEventReceived?: unknown;
    };
}

type OfficeWindow = Window & { Office?: OfficeDialogRuntime };
type GateStatus = "idle" | "opening" | "completing";

function getOfficeRuntime(): OfficeDialogRuntime | undefined {
    return typeof window === "undefined"
        ? undefined
        : (window as OfficeWindow).Office;
}

function isSuccessStatus(runtime: OfficeDialogRuntime, status: unknown) {
    return (
        status === runtime.AsyncResultStatus?.Succeeded ||
        String(status).toLowerCase() === "succeeded"
    );
}

function dialogClosedMessage(code: number | undefined) {
    if (code === 12006) return "Sign-in was closed before it finished.";
    return "The Office sign-in dialog closed before Vera received a session.";
}

export function OfficeAuthGate({ children }: { children: ReactNode }) {
    const searchParams = useSearchParams();
    const previewMode = searchParams.get("preview");
    const isFixturePreview = [
        "ready",
        "empty",
        "progress",
        "retrying",
        "restore-retry",
        "restore-unavailable",
    ].includes(previewMode ?? "");
    const { authLoading, isAuthenticated } = useAuth();
    const [officeScriptReady, setOfficeScriptReady] = useState(false);
    const [status, setStatus] = useState<GateStatus>("idle");
    const [inlineFallback, setInlineFallback] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [inlineSubmitting, setInlineSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dialogRef = useRef<OfficeDialog | null>(null);
    const dialogAttemptRef = useRef(0);
    const dialogTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    function clearDialogOpeningTimeout() {
        if (dialogTimeoutRef.current !== null) {
            clearTimeout(dialogTimeoutRef.current);
            dialogTimeoutRef.current = null;
        }
    }

    function showInlineFallback(message: string) {
        clearDialogOpeningTimeout();
        dialogAttemptRef.current += 1;
        setStatus("idle");
        setInlineFallback(true);
        setError(message);
    }

    useEffect(() => {
        if (getOfficeRuntime()) setOfficeScriptReady(true);
        return () => {
            clearDialogOpeningTimeout();
            dialogAttemptRef.current += 1;
            const dialog = dialogRef.current;
            dialogRef.current = null;
            dialog?.close();
        };
    }, []);

    async function signInWithOfficeDialog(retryFromFallback = false) {
        if (status !== "idle" || (inlineFallback && !retryFromFallback)) return;
        const attempt = dialogAttemptRef.current + 1;
        dialogAttemptRef.current = attempt;
        setStatus("opening");
        setInlineFallback(false);
        setError(null);
        clearDialogOpeningTimeout();
        dialogTimeoutRef.current = setTimeout(() => {
            if (dialogAttemptRef.current !== attempt || dialogRef.current) return;
            showInlineFallback(
                "The Word sign-in window did not open. Sign in in this task pane instead.",
            );
        }, OFFICE_DIALOG_OPEN_TIMEOUT_MS);

        try {
            const runtime = getOfficeRuntime();
            if (!runtime) {
                throw new Error(
                    "Office sign-in is unavailable in this host. Open Vera in a supported Word desktop client.",
                );
            }
            await readyOfficeRuntime(runtime);
            if (dialogAttemptRef.current !== attempt) return;

            const nonce = createOfficeAuthNonce();
            const expectedOrigin = window.location.origin;
            const dialogUrl = buildOfficeAuthDialogUrl(expectedOrigin, nonce);

            displayOfficeDialog(
                runtime.context?.ui,
                dialogUrl,
                { height: 65, width: 35, displayInIframe: false },
                (result) => {
                    if (dialogAttemptRef.current !== attempt) {
                        result.value?.close();
                        return;
                    }
                    clearDialogOpeningTimeout();
                    if (!isSuccessStatus(runtime, result.status) || !result.value) {
                        showInlineFallback(
                            result.error?.message ||
                                "The Word sign-in window did not open. Sign in in this task pane instead.",
                        );
                        return;
                    }

                    const dialog = result.value;
                    dialogRef.current = dialog;
                    const messageEvent = runtime.EventType?.DialogMessageReceived;
                    const closeEvent = runtime.EventType?.DialogEventReceived;
                    if (messageEvent === undefined || closeEvent === undefined) {
                        dialogRef.current = null;
                        dialog.close();
                        setStatus("idle");
                        setError("This Word version does not support secure dialog messaging.");
                        return;
                    }

                    dialog.addEventHandler(messageEvent, (rawEvent) => {
                        const event = rawEvent as OfficeDialogMessageEvent;
                        if (event.origin && event.origin !== expectedOrigin) {
                            setStatus("idle");
                            setError("Vera rejected a sign-in response from another origin.");
                            dialogRef.current = null;
                            dialog.close();
                            return;
                        }

                        let message;
                        try {
                            message = parseOfficeAuthDialogMessage(
                                event.message,
                                nonce,
                            );
                        } catch (messageError) {
                            setStatus("idle");
                            setError(
                                messageError instanceof Error
                                    ? messageError.message
                                    : "Vera rejected the sign-in response.",
                            );
                            dialogRef.current = null;
                            dialog.close();
                            return;
                        }

                        if (message.status !== "success") {
                            setStatus("idle");
                            setError(
                                message.status === "cancelled"
                                    ? "Sign-in was cancelled."
                                    : message.message || "Vera sign-in failed.",
                            );
                            dialogRef.current = null;
                            dialog.close();
                            return;
                        }

                        setStatus("completing");
                        void supabase.auth
                            .setSession({
                                access_token: message.accessToken,
                                refresh_token: message.refreshToken,
                            })
                            .then(({ data, error: sessionError }) => {
                                if (sessionError || !data.session?.user) {
                                    throw (
                                        sessionError ??
                                        new Error("Vera could not restore the signed-in session.")
                                    );
                                }
                                setError(null);
                            })
                            .catch((sessionError) => {
                                setStatus("idle");
                                setError(
                                    sessionError instanceof Error
                                        ? sessionError.message
                                        : "Vera could not restore the signed-in session.",
                                );
                            })
                            .finally(() => {
                                if (dialogRef.current === dialog) {
                                    dialogRef.current = null;
                                }
                                dialog.close();
                            });
                    });

                    dialog.addEventHandler(closeEvent, (rawEvent) => {
                        if (dialogRef.current !== dialog) return;
                        dialogRef.current = null;
                        setStatus("idle");
                        setError(
                            dialogClosedMessage((rawEvent as OfficeDialogEvent).error),
                        );
                    });
                },
            );
        } catch (dialogError) {
            if (dialogAttemptRef.current !== attempt) return;
            showInlineFallback(
                dialogError instanceof Error
                    ? dialogError.message
                    : "The Word sign-in window did not open. Sign in in this task pane instead.",
            );
        }
    }

    async function signInInline(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setInlineSubmitting(true);
        setError(null);
        try {
            const { error: signInError } = await supabase.auth.signInWithPassword({
                email,
                password,
            });
            if (signInError) throw signInError;
        } catch (signInError) {
            setError(
                signInError instanceof Error
                    ? signInError.message
                    : "Vera sign-in failed.",
            );
        } finally {
            setInlineSubmitting(false);
        }
    }

    function cancelInlineFallback() {
        setInlineFallback(false);
        setEmail("");
        setPassword("");
        setError(null);
    }

    if (isFixturePreview || isAuthenticated) return <>{children}</>;

    return (
        <>
            <Script
                src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"
                strategy="afterInteractive"
                onReady={() => setOfficeScriptReady(true)}
                onError={() => {
                    setOfficeScriptReady(false);
                    setError("Vera could not load the Office sign-in service.");
                }}
            />
            <div className="min-h-dvh bg-gray-50/80 px-4 py-5 text-gray-900">
                <div className="mx-auto flex min-h-[calc(100dvh-2.5rem)] w-full max-w-[30rem] flex-col rounded-xl border border-gray-200/80 bg-white p-4 shadow-sm">
                    <header className="flex min-h-10 items-center border-b border-gray-200/80 pb-4">
                        <SiteLogo size="sm" className="text-gray-900" />
                    </header>
                    <main className="flex flex-1 flex-col justify-center py-8">
                        <div className="mx-auto w-full max-w-sm">
                            <h1 className="text-xl font-semibold text-gray-950">
                                Sign in to review in Word
                            </h1>
                            <p className="mt-3 text-sm leading-6 text-gray-600">
                                Vera opens a separate Office sign-in window, then restores
                                your existing Vera session in this task pane.
                            </p>
                            {inlineFallback ? (
                                <form onSubmit={signInInline} className="mt-6 space-y-4">
                                    <p className="text-sm leading-6 text-gray-600">
                                        The Word sign-in window did not open. Continue in this
                                        task pane instead.
                                    </p>
                                    <div>
                                        <label
                                            htmlFor="office-inline-email"
                                            className="mb-2 block text-sm font-medium text-gray-700"
                                        >
                                            Email
                                        </label>
                                        <Input
                                            id="office-inline-email"
                                            type="email"
                                            autoComplete="email"
                                            autoFocus
                                            value={email}
                                            onChange={(event) => setEmail(event.target.value)}
                                            required
                                            className="w-full rounded-lg bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-300/50"
                                        />
                                    </div>
                                    <div>
                                        <label
                                            htmlFor="office-inline-password"
                                            className="mb-2 block text-sm font-medium text-gray-700"
                                        >
                                            Password
                                        </label>
                                        <Input
                                            id="office-inline-password"
                                            type="password"
                                            autoComplete="current-password"
                                            value={password}
                                            onChange={(event) => setPassword(event.target.value)}
                                            required
                                            className="w-full rounded-lg bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-300/50"
                                        />
                                    </div>
                                    <Button
                                        type="submit"
                                        disabled={inlineSubmitting}
                                        className="min-h-10 w-full bg-black text-white hover:bg-gray-900 focus-visible:ring-2 focus-visible:ring-gray-500/50"
                                    >
                                        {inlineSubmitting ? "Signing in..." : "Sign in"}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={inlineSubmitting}
                                        onClick={() =>
                                            void signInWithOfficeDialog(true)
                                        }
                                        className="min-h-10 w-full text-gray-600 focus-visible:ring-2 focus-visible:ring-gray-400/50"
                                    >
                                        Try Word sign-in again
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={inlineSubmitting}
                                        onClick={cancelInlineFallback}
                                        className="min-h-10 w-full text-gray-600 focus-visible:ring-2 focus-visible:ring-gray-400/50"
                                    >
                                        Cancel
                                    </Button>
                                </form>
                            ) : (
                                <>
                                    <Button
                                        type="button"
                                        onClick={() => void signInWithOfficeDialog()}
                                        disabled={
                                            authLoading ||
                                            status !== "idle" ||
                                            (!officeScriptReady && !getOfficeRuntime())
                                        }
                                        className="mt-6 min-h-10 w-full bg-black text-white hover:bg-gray-900 focus-visible:ring-2 focus-visible:ring-gray-500/50"
                                    >
                                        {authLoading || status !== "idle" ? (
                                            <span className="inline-flex items-center gap-2">
                                                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                                                {status === "completing"
                                                    ? "Restoring session..."
                                                    : "Opening sign-in..."}
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-2">
                                                <LogIn className="h-4 w-4" />
                                                Sign in to Vera
                                            </span>
                                        )}
                                    </Button>
                                    <p className="mt-5 text-xs leading-5 text-gray-500">
                                        If you are viewing this page outside Word, sign in from the{
                                        " "}
                                        <Link
                                            href="/login"
                                            className="font-medium text-gray-700 underline decoration-gray-300 underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50"
                                        >
                                            Vera web app
                                        </Link>
                                        , then reopen the add-in.
                                    </p>
                                </>
                            )}
                            {error && (
                                <p
                                    role="alert"
                                    className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm leading-5 text-red-700"
                                >
                                    {error}
                                </p>
                            )}
                        </div>
                    </main>
                </div>
            </div>
        </>
    );
}
