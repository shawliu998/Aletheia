"use client";

import Script from "next/script";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SiteLogo } from "@/app/components/site-logo";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    createOfficeAuthStatusMessage,
    createOfficeAuthSuccessMessage,
    isValidOfficeAuthNonce,
} from "@/app/lib/officeDialogAuth";
import {
    messageOfficeTaskPane,
    type OfficeDialogChildUi,
} from "@/app/lib/officeDialogRuntime";
import { supabase } from "@/app/lib/supabase";

interface OfficeDialogChildRuntime {
    context?: {
        ui?: OfficeDialogChildUi;
    };
}

type OfficeDialogWindow = Window & { Office?: OfficeDialogChildRuntime };

function getDialogRuntime(): OfficeDialogChildRuntime | undefined {
    return typeof window === "undefined"
        ? undefined
        : (window as OfficeDialogWindow).Office;
}

function sendToTaskPane(message: unknown) {
    messageOfficeTaskPane(getDialogRuntime()?.context?.ui, JSON.stringify(message), {
        targetOrigin: window.location.origin,
    });
}

export default function OfficeAuthDialogPage() {
    const searchParams = useSearchParams();
    const nonce = searchParams.get("nonce");
    const { authLoading, isAuthenticated } = useAuth();
    const { profile, loading: profileLoading } = useUserProfile();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [officeScriptReady, setOfficeScriptReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const sentRef = useRef(false);

    useEffect(() => {
        if (getDialogRuntime()) setOfficeScriptReady(true);
    }, []);

    useEffect(() => {
        if (
            sentRef.current ||
            !isValidOfficeAuthNonce(nonce) ||
            !officeScriptReady ||
            authLoading ||
            !isAuthenticated ||
            profileLoading ||
            !profile
        ) {
            return;
        }

        let cancelled = false;
        async function finishSignIn() {
            try {
                if (profile?.mfaOnLogin) {
                    const { data: assurance, error: assuranceError } =
                        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
                    if (assuranceError) throw assuranceError;
                    if (
                        assurance.nextLevel === "aal2" &&
                        assurance.currentLevel !== "aal2"
                    ) {
                        return;
                    }
                }

                const {
                    data: { session },
                    error: sessionError,
                } = await supabase.auth.getSession();
                if (sessionError) throw sessionError;
                if (!session) throw new Error("Vera did not return a signed-in session.");
                if (cancelled) return;

                sendToTaskPane(createOfficeAuthSuccessMessage(nonce!, session));
                sentRef.current = true;
            } catch (finishError) {
                if (!cancelled) {
                    setError(
                        finishError instanceof Error
                            ? finishError.message
                            : "Vera could not complete Office sign-in.",
                    );
                }
            }
        }

        void finishSignIn();
        return () => {
            cancelled = true;
        };
    }, [
        authLoading,
        isAuthenticated,
        nonce,
        officeScriptReady,
        profile,
        profileLoading,
    ]);

    async function handleLogin(event: React.FormEvent) {
        event.preventDefault();
        if (!isValidOfficeAuthNonce(nonce)) return;
        setSubmitting(true);
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
            setSubmitting(false);
        }
    }

    function cancelSignIn() {
        if (!isValidOfficeAuthNonce(nonce)) return;
        try {
            sendToTaskPane(createOfficeAuthStatusMessage(nonce, "cancelled"));
        } catch (cancelError) {
            setError(
                cancelError instanceof Error
                    ? cancelError.message
                    : "Vera could not close sign-in.",
            );
        }
    }

    const invalidNonce = !isValidOfficeAuthNonce(nonce);
    const completing =
        !invalidNonce &&
        (authLoading ||
            isAuthenticated ||
            profileLoading ||
            !officeScriptReady);

    return (
        <>
            <Script
                src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"
                strategy="afterInteractive"
                onReady={() => setOfficeScriptReady(true)}
                onError={() =>
                    setError("Vera could not load the Office sign-in service.")
                }
            />
            <div className="min-h-dvh bg-gray-50 px-5 py-8 text-gray-900">
                <div className="mx-auto w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                    <SiteLogo size="sm" className="text-gray-900" />
                    <h1 className="mt-8 text-xl font-semibold text-gray-950">
                        Sign in to Vera
                    </h1>
                    <p className="mt-2 text-sm leading-6 text-gray-600">
                        Continue your Word review with the same Vera account and
                        session used by the web app.
                    </p>

                    {invalidNonce ? (
                        <p
                            role="alert"
                            className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
                        >
                            This Office sign-in request is invalid. Close it and try
                            again from Word.
                        </p>
                    ) : completing ? (
                        <div
                            role="status"
                            className="mt-8 flex items-center gap-2 text-sm text-gray-600"
                        >
                            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                            Completing secure sign-in...
                        </div>
                    ) : (
                        <form onSubmit={handleLogin} className="mt-6 space-y-4">
                            <div>
                                <label
                                    htmlFor="office-auth-email"
                                    className="mb-2 block text-sm font-medium text-gray-700"
                                >
                                    Email
                                </label>
                                <Input
                                    id="office-auth-email"
                                    type="email"
                                    autoComplete="email"
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    required
                                    className="w-full rounded-lg bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-300/50"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="office-auth-password"
                                    className="mb-2 block text-sm font-medium text-gray-700"
                                >
                                    Password
                                </label>
                                <Input
                                    id="office-auth-password"
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
                                disabled={submitting}
                                className="min-h-10 w-full bg-black text-white hover:bg-gray-900 focus-visible:ring-2 focus-visible:ring-gray-500/50"
                            >
                                {submitting ? "Signing in..." : "Sign in"}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={cancelSignIn}
                                disabled={submitting}
                                className="min-h-10 w-full text-gray-600 focus-visible:ring-2 focus-visible:ring-gray-400/50"
                            >
                                Cancel
                            </Button>
                        </form>
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
            </div>
        </>
    );
}
