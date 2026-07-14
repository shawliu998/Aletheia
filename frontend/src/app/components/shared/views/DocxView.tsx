"use client";

// Authenticated local adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/views/DocxView.tsx
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/app/i18n";
import { ViewerError, ViewerLoading } from "./PdfView";
import { useVeraDisplayBlob } from "./useVeraDisplayBlob";

interface Props {
    documentId: string;
    versionId?: string | null;
    onReady?: () => void;
    rounded?: boolean;
}

type RenderState = {
    blob: Blob | null;
    ready: boolean;
    error: unknown;
};

export function DocxView({
    documentId,
    versionId,
    onReady,
    rounded = true,
}: Props) {
    const { errorMessage } = useI18n();
    const { blob, loading, error } = useVeraDisplayBlob(
        documentId,
        versionId,
    );
    const rootRef = useRef<HTMLDivElement>(null);
    const [renderState, setRenderState] = useState<RenderState>({
        blob: null,
        ready: false,
        error: null,
    });

    useEffect(() => {
        if (!blob || !rootRef.current) return;
        let cancelled = false;
        const root = rootRef.current;
        root.replaceChildren();
        blob.arrayBuffer()
            .then(async (bytes) => {
                const { renderAsync } = await import("docx-preview");
                if (cancelled) return;
                await renderAsync(bytes, root, undefined, {
                    className: "vera-docx",
                    inWrapper: true,
                    ignoreWidth: false,
                    ignoreHeight: false,
                    breakPages: true,
                });
                if (!cancelled) {
                    setRenderState({ blob, ready: true, error: null });
                    onReady?.();
                }
            })
            .catch((reason: unknown) => {
                if (!cancelled) {
                    setRenderState({ blob, ready: false, error: reason });
                }
            });
        return () => {
            cancelled = true;
            root.replaceChildren();
        };
    }, [blob, onReady]);

    if (loading) return <ViewerLoading />;
    if (error || (renderState.blob === blob && renderState.error)) {
        return (
            <ViewerError
                message={errorMessage(
                    (error ?? renderState.error) as Error,
                )}
            />
        );
    }

    return (
        <div
            className={`relative h-full min-h-[360px] overflow-auto bg-gray-100 p-4 ${
                rounded ? "rounded-xl" : ""
            }`}
        >
            <div
                key={`${documentId}:${versionId ?? "current"}`}
                ref={rootRef}
                className="mx-auto min-h-full"
            />
            {(!blob ||
                renderState.blob !== blob ||
                !renderState.ready) && (
                <div className="absolute inset-0 bg-gray-100">
                    <ViewerLoading />
                </div>
            )}
        </div>
    );
}
