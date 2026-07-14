"use client";

// Authenticated local adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/views/PdfView.tsx
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { useVeraDisplayBlob } from "./useVeraDisplayBlob";

const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 1;

function blobId(blob: Blob) {
    const existing = blobIds.get(blob);
    if (existing) return existing;
    const id = nextBlobId;
    nextBlobId += 1;
    blobIds.set(blob, id);
    return id;
}

interface Props {
    doc: { document_id: string; version_id?: string | null } | null;
    rounded?: boolean;
}

export function PdfView({ doc, rounded = true }: Props) {
    const { t, errorMessage } = useI18n();
    const { blob, loading, error } = useVeraDisplayBlob(
        doc?.document_id ?? null,
        doc?.version_id,
    );
    if (loading) return <ViewerLoading />;
    if (error) {
        return <ViewerError message={errorMessage(error as Error)} />;
    }
    if (blob && blob.type.toLowerCase() !== "application/pdf") {
        return <ViewerError message={t("errors.invalidResponse")} />;
    }
    if (!blob) return <ViewerError message={t("documents.errors.load")} />;

    return (
        <PdfBlobFrame
            key={blobId(blob)}
            blob={blob}
            title={t("documents.preview")}
            rounded={rounded}
        />
    );
}

function PdfBlobFrame({
    blob,
    title,
    rounded,
}: {
    blob: Blob;
    title: string;
    rounded: boolean;
}) {
    const [url] = useState(() => URL.createObjectURL(blob));
    useEffect(() => () => URL.revokeObjectURL(url), [url]);
    return (
        <iframe
            src={url}
            title={title}
            className={`h-full min-h-[360px] w-full bg-white ${
                rounded ? "rounded-xl" : ""
            }`}
        />
    );
}

export function ViewerLoading() {
    const { t } = useI18n();
    return (
        <div className="flex h-full min-h-[260px] items-center justify-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t("common.status.loading")}
        </div>
    );
}

export function ViewerError({ message }: { message: string }) {
    return (
        <div
            role="alert"
            className="flex h-full min-h-[260px] items-center justify-center p-8 text-center text-sm text-red-600"
        >
            {message}
        </div>
    );
}
