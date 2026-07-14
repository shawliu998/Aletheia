"use client";

import { useEffect, useState } from "react";
import { displayVeraDocument } from "@/app/lib/veraApi";

type DisplayState = {
    key: string | null;
    blob: Blob | null;
    error: unknown;
};

export function useVeraDisplayBlob(
    documentId: string | null,
    versionId?: string | null,
) {
    const requestKey = documentId
        ? `${documentId}:${versionId ?? "current"}`
        : null;
    const [state, setState] = useState<DisplayState>({
        key: null,
        blob: null,
        error: null,
    });

    useEffect(() => {
        if (!documentId || !requestKey) return;
        const controller = new AbortController();
        displayVeraDocument(
            documentId,
            versionId ?? undefined,
            controller.signal,
        )
            .then((response) => {
                if (!controller.signal.aborted) {
                    setState({
                        key: requestKey,
                        blob: response.blob,
                        error: null,
                    });
                }
            })
            .catch((reason: unknown) => {
                if (!controller.signal.aborted) {
                    setState({ key: requestKey, blob: null, error: reason });
                }
            });
        return () => controller.abort();
    }, [documentId, requestKey, versionId]);

    if (!requestKey) {
        return { blob: null, loading: false, error: null };
    }
    if (state.key !== requestKey) {
        return { blob: null, loading: true, error: null };
    }
    return { blob: state.blob, loading: false, error: state.error };
}
