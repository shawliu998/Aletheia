"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";
import { ViewerError, ViewerLoading } from "./PdfView";
import { useVeraDisplayBlob } from "./useVeraDisplayBlob";

type TextState = {
    blob: Blob | null;
    text: string;
    error: unknown;
};

export function TextView({
    documentId,
    versionId,
}: {
    documentId: string;
    versionId?: string | null;
}) {
    const { errorMessage } = useI18n();
    const { blob, loading, error } = useVeraDisplayBlob(
        documentId,
        versionId,
    );
    const [decoded, setDecoded] = useState<TextState>({
        blob: null,
        text: "",
        error: null,
    });

    useEffect(() => {
        if (!blob) return;
        let cancelled = false;
        blob.text()
            .then((value) => {
                if (!cancelled) {
                    setDecoded({ blob, text: value, error: null });
                }
            })
            .catch((reason: unknown) => {
                if (!cancelled) {
                    setDecoded({ blob, text: "", error: reason });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [blob]);

    if (loading) return <ViewerLoading />;
    if (error || (decoded.blob === blob && decoded.error)) {
        return (
            <ViewerError
                message={errorMessage(
                    (error ?? decoded.error) as Error,
                )}
            />
        );
    }
    if (!blob || decoded.blob !== blob) return <ViewerLoading />;
    return (
        <pre className="h-full min-h-[360px] overflow-auto whitespace-pre-wrap rounded-xl bg-white p-5 text-sm leading-6 text-gray-700">
            {decoded.text}
        </pre>
    );
}
