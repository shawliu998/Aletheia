"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/useDirectoryData.ts
import { useEffect, useState } from "react";
import {
    getVeraProject,
    listVeraProjects,
    listVeraStandaloneDocuments,
} from "@/app/lib/veraApi";
import type {
    VeraDocumentWire,
    VeraProjectWire,
} from "@/app/lib/veraWireTypes";

const CACHE_TTL_MS = 30_000;

interface DirectoryCache {
    standaloneDocuments: VeraDocumentWire[];
    projects: VeraProjectWire[];
    fetchedAt: number;
}

let cache: DirectoryCache | null = null;

export function invalidateDirectoryCache() {
    cache = null;
}

export function useDirectoryData(enabled: boolean) {
    const [loading, setLoading] = useState(enabled);
    const [error, setError] = useState<unknown>(null);
    const [standaloneDocuments, setStandaloneDocuments] = useState<
        VeraDocumentWire[]
    >([]);
    const [projects, setProjects] = useState<VeraProjectWire[]>([]);

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const controller = new AbortController();
        const cached = cache;
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
            queueMicrotask(() => {
                if (controller.signal.aborted) return;
                setStandaloneDocuments(cached.standaloneDocuments);
                setProjects(cached.projects);
                setError(null);
                setLoading(false);
            });
            return () => controller.abort();
        }

        queueMicrotask(() => {
            if (!controller.signal.aborted) setLoading(true);
        });
        Promise.all([
            listVeraProjects(controller.signal),
            listVeraStandaloneDocuments({}, controller.signal),
        ])
            .then(async ([projectRows, documentRows]) => {
                const fullProjects = await Promise.all(
                    projectRows.map((project) =>
                        getVeraProject(project.id, controller.signal),
                    ),
                );
                if (controller.signal.aborted) return;
                const sortedDocuments = [...documentRows].sort((a, b) =>
                    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
                );
                cache = {
                    standaloneDocuments: sortedDocuments,
                    projects: fullProjects,
                    fetchedAt: Date.now(),
                };
                setStandaloneDocuments(sortedDocuments);
                setProjects(fullProjects);
                setError(null);
            })
            .catch((reason: unknown) => {
                if (controller.signal.aborted) return;
                setStandaloneDocuments([]);
                setProjects([]);
                setError(reason);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });

        return () => controller.abort();
    }, [enabled]);

    return {
        loading: enabled && loading,
        error,
        standaloneDocuments,
        projects,
    };
}
