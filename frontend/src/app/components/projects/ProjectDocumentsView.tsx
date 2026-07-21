"use client";

import {
    type Dispatch,
    type SetStateAction,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { ArrowLeft, ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
    createProjectFolder,
    deleteProjectFolder,
    getProject,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    renameProjectDocument,
    renameProjectFolder,
    uploadProjectDocument,
} from "@/app/lib/mikeApi";
import type { Document } from "@/app/components/shared/types";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import {
    DocTable,
    type DocTableSelectionActions,
    type DocTableFolder,
    type DocumentDeepLinkTarget,
} from "@/app/components/documents/DocTable";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { ProjectSectionToolbar, useProjectWorkspace } from "./ProjectWorkspace";
import { APP_SURFACE_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

interface Props {
    projectId: string;
}

export function ProjectDocumentsView({ projectId }: Props) {
    const searchParams = useSearchParams();
    const workspace = useProjectWorkspace();
    const {
        project,
        setProject,
        folders,
        setFolders,
        projectLoading,
        prefetchProjectSections,
        search,
        setOwnerOnlyAction,
    } = workspace;
    const [createFolderAction, setCreateFolderAction] = useState<
        (() => void) | null
    >(null);
    const [selectionActions, setSelectionActions] =
        useState<DocTableSelectionActions | null>(null);
    const [actionsOpen, setActionsOpen] = useState(false);
    const actionsRef = useRef<HTMLDivElement>(null);
    const returnTaskId = searchParams.get("return_task");
    const deepLinkTarget = useMemo<DocumentDeepLinkTarget | null>(() => {
        const documentId = searchParams.get("open_document");
        if (!documentId) return null;
        const rawStatus = searchParams.get("citation_status");
        const status =
            rawStatus === "exact" ||
            rawStatus === "drifted" ||
            rawStatus === "missing" ||
            rawStatus === "version_mismatch"
                ? rawStatus
                : null;
        const rawPage = searchParams.get("page");
        return {
            documentId,
            returnTaskId,
            versionId: searchParams.get("version_id"),
            status,
            detail: searchParams.get("citation_detail"),
            page: rawPage,
            quote: searchParams.get("quote"),
            sheet: searchParams.get("sheet"),
            cell: searchParams.get("cell"),
        };
    }, [returnTaskId, searchParams]);

    useEffect(() => {
        if (!projectLoading) prefetchProjectSections();
    }, [projectLoading, prefetchProjectSections]);

    useEffect(() => {
        function handleClick(event: MouseEvent) {
            if (!actionsRef.current?.contains(event.target as Node)) {
                setActionsOpen(false);
            }
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    const documents = project?.documents ?? [];
    const setDocuments = useCallback(
        (update: SetStateAction<Document[]>) => {
            setProject((prev) => {
                if (!prev) return prev;
                const nextDocuments =
                    typeof update === "function"
                        ? update(prev.documents ?? [])
                        : update;
                return { ...prev, documents: nextDocuments };
            });
        },
        [setProject],
    );

    const refreshCollection = useCallback(async () => {
        const updated = await getProject(projectId);
        setProject(updated);
        setFolders(updated.folders ?? []);
    }, [projectId, setFolders, setProject]);
    const operations = useMemo(
        () => ({
            uploadDocument: (file: File) =>
                uploadProjectDocument(projectId, file),
            refreshCollection,
            createFolder: (name: string, parentFolderId?: string | null) =>
                createProjectFolder(projectId, name, parentFolderId),
            renameFolder: (folderId: string, name: string) =>
                renameProjectFolder(projectId, folderId, name),
            deleteFolder: (folderId: string) =>
                deleteProjectFolder(projectId, folderId),
            moveFolder: (folderId: string, parentFolderId: string | null) =>
                moveSubfolderToFolder(projectId, folderId, parentFolderId),
            moveDocument: (documentId: string, folderId: string | null) =>
                moveDocumentToFolder(projectId, documentId, folderId),
            renameDocument: (documentId: string, filename: string) =>
                renameProjectDocument(projectId, documentId, filename),
        }),
        [projectId, refreshCollection],
    );

    const handleCreateFolderActionChange = useCallback(
        (action: (() => void) | null) => {
            setCreateFolderAction(() => action);
        },
        [],
    );
    const handleSelectionActionsChange = useCallback(
        (actions: DocTableSelectionActions | null) => {
            setSelectionActions(actions);
        },
        [],
    );

    const toolbarActions = (
        <div className="flex items-center gap-1.5">
            {selectionActions && (
                <div ref={actionsRef} className="relative">
                    <TabPillButton
                        onClick={() => setActionsOpen((open) => !open)}
                    >
                        Actions
                        <ChevronDown className="h-3.5 w-3.5" />
                    </TabPillButton>
                    {actionsOpen && (
                        <div className="absolute top-full right-0 z-[120] mt-1 w-36 overflow-hidden rounded-lg border border-gray-100 bg-app-surface shadow-lg">
                            <button
                                onClick={() => {
                                    setActionsOpen(false);
                                    void selectionActions.onDownload();
                                }}
                                className={`w-full px-3 py-1.5 text-left text-xs text-gray-600 transition-colors ${APP_SURFACE_HOVER_CLASS}`}
                            >
                                Download
                            </button>
                            {selectionActions.hasDocumentsInFolders && (
                                <button
                                    onClick={() => {
                                        setActionsOpen(false);
                                        void selectionActions.onRemoveFromFolder();
                                    }}
                                    className={`w-full px-3 py-1.5 text-left text-xs text-gray-600 transition-colors ${APP_SURFACE_HOVER_CLASS}`}
                                >
                                    Remove from subfolder
                                </button>
                            )}
                            <button
                                onClick={() => {
                                    setActionsOpen(false);
                                    void selectionActions.onDelete();
                                }}
                                className="w-full px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-50"
                            >
                                Delete
                            </button>
                        </div>
                    )}
                </div>
            )}
            <TabPillButton
                onClick={createFolderAction ?? undefined}
                disabled={!createFolderAction || projectLoading}
            >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Folder</span>
            </TabPillButton>
        </div>
    );

    if (!projectLoading && !project) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-gray-400">Project not found</p>
            </div>
        );
    }

    return (
        <>
            {returnTaskId && (
                <div className="flex min-h-9 items-center gap-3 border-b border-gray-900/[0.055] px-4 text-[11px] text-gray-600 md:px-6">
                    <Link
                        href={`/agent-tasks/${encodeURIComponent(returnTaskId)}?restore=1`}
                        className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 font-medium text-gray-800 outline-none hover:bg-gray-900/[0.04] focus-visible:ring-2 focus-visible:ring-blue-500/70"
                    >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        Work task
                    </Link>
                    <span className="h-3 w-px bg-gray-200" aria-hidden="true" />
                    <span
                        className="min-w-0 truncate"
                        title={deepLinkTarget?.detail ?? undefined}
                    >
                        {deepLinkTarget?.status === "exact"
                            ? "Citation located in the referenced version"
                            : deepLinkTarget?.status === "version_mismatch"
                              ? "Viewing the cited version; the source has since changed"
                              : deepLinkTarget?.status === "drifted"
                                ? "Source opened; the citation anchor has drifted"
                                : deepLinkTarget
                                  ? "Opened from task evidence"
                                  : "Opened from work task"}
                    </span>
                </div>
            )}
            <ProjectSectionToolbar actions={toolbarActions} />
            <DocTable
                scopeKey={projectId}
                documents={documents}
                setDocuments={setDocuments}
                folders={folders}
                setFolders={
                    setFolders as Dispatch<SetStateAction<DocTableFolder[]>>
                }
                loading={projectLoading}
                search={search}
                operations={operations}
                onAddDocumentsActionChange={
                    workspace.setAddDocumentsHeaderAction
                }
                onCreateFolderActionChange={handleCreateFolderActionChange}
                onSelectionActionsChange={handleSelectionActionsChange}
                renderAddDocumentsModal={(open, onClose, onSelect) =>
                    project ? (
                        <AddDocumentsModal
                            open={open}
                            onClose={onClose}
                            onSelect={onSelect}
                            breadcrumb={[
                                "Projects",
                                project.name +
                                    (project.cm_number
                                        ? ` (${project.cm_number})`
                                        : ""),
                                "Add Documents",
                            ]}
                            projectId={projectId}
                        />
                    ) : null
                }
                onOwnerOnlyAction={setOwnerOnlyAction}
                deepLinkTarget={deepLinkTarget}
            />
        </>
    );
}
