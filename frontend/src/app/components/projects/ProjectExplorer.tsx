"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectExplorer.tsx
import { useEffect, useRef, useState } from "react";
import {
    ChevronDown,
    ChevronRight,
    Folder,
    FolderOpen,
    FolderPlus,
    Trash2,
} from "lucide-react";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { VersionChip } from "@/app/components/shared/VersionChip";
import { useI18n } from "@/app/i18n";
import type {
    VeraDocumentWire,
    VeraFolderWire,
} from "@/app/lib/veraWireTypes";

interface Props {
    projectName?: string | null;
    documents: VeraDocumentWire[];
    folders?: VeraFolderWire[];
    selectedDocId?: string | null;
    onDocClick: (doc: VeraDocumentWire) => void;
    onCreateFolder?: (
        parentFolderId: string | null,
        name: string,
    ) => Promise<void>;
    onRenameFolder?: (folderId: string, name: string) => Promise<void>;
    onDeleteFolder?: (folderId: string) => Promise<void>;
    onDeleteDoc?: (docId: string) => Promise<void>;
    onMoveDoc?: (
        docId: string,
        targetFolderId: string | null,
    ) => Promise<void>;
    onMoveFolder?: (
        folderId: string,
        targetFolderId: string | null,
    ) => Promise<void>;
}

type ContextMenuState = {
    x: number;
    y: number;
    parentId: string | null;
    folderId?: string;
    docId?: string;
};

const VERA_DOCUMENT_DRAG = "application/vera-document";
const VERA_FOLDER_DRAG = "application/vera-folder";

export function ProjectExplorer({
    projectName,
    documents,
    folders = [],
    selectedDocId,
    onDocClick,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onDeleteDoc,
    onMoveDoc,
    onMoveFolder,
}: Props) {
    const { t } = useI18n();
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(
        null,
    );
    const [creatingIn, setCreatingIn] = useState<
        string | null | undefined
    >(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(
        null,
    );
    const [dragOverRoot, setDragOverRoot] = useState(false);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!contextMenu) return;
        const handlePointer = (event: MouseEvent) => {
            if (
                contextMenuRef.current &&
                !contextMenuRef.current.contains(event.target as Node)
            ) {
                setContextMenu(null);
            }
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setContextMenu(null);
        };
        document.addEventListener("mousedown", handlePointer);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handlePointer);
            document.removeEventListener("keydown", handleKey);
        };
    }, [contextMenu]);

    useEffect(() => {
        const clearDrag = () => {
            setDragOverFolderId(null);
            setDragOverRoot(false);
        };
        document.addEventListener("dragend", clearDrag);
        return () => document.removeEventListener("dragend", clearDrag);
    }, []);

    const toggleFolder = (id: string) => {
        setExpandedIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const commitNewFolder = async (parentId: string | null) => {
        const name = newFolderName.trim();
        if (!name || !onCreateFolder) return;
        setCreatingIn(undefined);
        setNewFolderName("");
        await onCreateFolder(parentId, name);
        if (parentId) {
            setExpandedIds((current) => new Set([...current, parentId]));
        }
    };

    const commitRename = async (folderId: string) => {
        const name = renameValue.trim();
        setRenamingId(null);
        if (name && onRenameFolder) await onRenameFolder(folderId, name);
    };

    const openContextMenu = (
        event: React.MouseEvent,
        parentId: string | null,
        folderId?: string,
        docId?: string,
    ) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            parentId,
            folderId,
            docId,
        });
    };

    const wouldCreateCycle = (movingId: string, targetId: string) => {
        let current = folders.find((folder) => folder.id === targetId);
        while (current) {
            if (current.id === movingId) return true;
            current = current.parent_folder_id
                ? folders.find(
                      (folder) => folder.id === current?.parent_folder_id,
                  )
                : undefined;
        }
        return false;
    };

    const handleDrop = async (
        targetFolderId: string | null,
        event: React.DragEvent,
    ) => {
        const documentId = event.dataTransfer.getData(VERA_DOCUMENT_DRAG);
        const folderId = event.dataTransfer.getData(VERA_FOLDER_DRAG);
        if (documentId && onMoveDoc) {
            const document = documents.find((item) => item.id === documentId);
            if (
                document &&
                (document.folder_id ?? null) !== targetFolderId
            ) {
                await onMoveDoc(documentId, targetFolderId);
            }
            return;
        }
        if (
            folderId &&
            folderId !== targetFolderId &&
            onMoveFolder &&
            (!targetFolderId || !wouldCreateCycle(folderId, targetFolderId))
        ) {
            const folder = folders.find((item) => item.id === folderId);
            if (folder && (folder.parent_folder_id ?? null) !== targetFolderId) {
                await onMoveFolder(folderId, targetFolderId);
            }
        }
    };

    const renderLevel = (
        parentId: string | null,
        depth: number,
    ): React.ReactNode => {
        const paddingLeft = 28 + Math.max(0, depth - 1) * 16;
        const childFolders = folders
            .filter((folder) => folder.parent_folder_id === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
        const childDocuments = documents.filter(
            (document) => (document.folder_id ?? null) === parentId,
        );
        return (
            <>
                {creatingIn === parentId && (
                    <li
                        className="flex items-center gap-1.5 py-1.5 pr-2"
                        style={{ paddingLeft }}
                    >
                        <FolderPlus className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <input
                            autoFocus
                            value={newFolderName}
                            placeholder={t("common.fields.name")}
                            onChange={(event) =>
                                setNewFolderName(event.target.value)
                            }
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    void commitNewFolder(parentId);
                                }
                                if (event.key === "Escape") {
                                    setCreatingIn(undefined);
                                    setNewFolderName("");
                                }
                            }}
                            onBlur={() => void commitNewFolder(parentId)}
                            className="min-w-0 flex-1 border-b border-gray-300 bg-transparent text-xs text-gray-800 outline-none"
                        />
                    </li>
                )}
                {childFolders.map((folder) => {
                    const expanded = expandedIds.has(folder.id);
                    return (
                        <li key={folder.id}>
                            <div
                                role="treeitem"
                                tabIndex={0}
                                draggable
                                aria-expanded={expanded}
                                aria-selected={false}
                                onClick={() => toggleFolder(folder.id)}
                                onKeyDown={(event) => {
                                    if (event.target !== event.currentTarget) {
                                        return;
                                    }
                                    if (
                                        event.key === "Enter" ||
                                        event.key === " "
                                    ) {
                                        event.preventDefault();
                                        toggleFolder(folder.id);
                                    }
                                }}
                                onContextMenu={(event) =>
                                    openContextMenu(
                                        event,
                                        folder.id,
                                        folder.id,
                                    )
                                }
                                onDragStart={(event) => {
                                    event.dataTransfer.setData(
                                        VERA_FOLDER_DRAG,
                                        folder.id,
                                    );
                                    event.dataTransfer.effectAllowed = "move";
                                }}
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setDragOverFolderId(folder.id);
                                    setDragOverRoot(false);
                                }}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setDragOverFolderId(null);
                                    void handleDrop(folder.id, event);
                                }}
                                className={`flex w-full items-center gap-1.5 rounded-sm py-1.5 pr-2 text-left transition-colors ${
                                    dragOverFolderId === folder.id
                                        ? "bg-blue-50 ring-1 ring-inset ring-blue-200"
                                        : "hover:bg-gray-50"
                                }`}
                                style={{ paddingLeft }}
                            >
                                {expanded ? (
                                    <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" />
                                ) : (
                                    <ChevronRight className="h-3 w-3 shrink-0 text-gray-400" />
                                )}
                                {expanded ? (
                                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                                ) : (
                                    <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                                )}
                                {renamingId === folder.id ? (
                                    <input
                                        autoFocus
                                        value={renameValue}
                                        onClick={(event) => event.stopPropagation()}
                                        onChange={(event) =>
                                            setRenameValue(event.target.value)
                                        }
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                void commitRename(folder.id);
                                            }
                                            if (event.key === "Escape") {
                                                setRenamingId(null);
                                            }
                                        }}
                                        onBlur={() => void commitRename(folder.id)}
                                        className="min-w-0 flex-1 border-b border-gray-300 bg-transparent text-xs text-gray-800 outline-none"
                                    />
                                ) : (
                                    <span className="min-w-0 flex-1 truncate text-xs text-gray-600">
                                        {folder.name}
                                    </span>
                                )}
                            </div>
                            {expanded && (
                                <ul role="group">
                                    {renderLevel(folder.id, depth + 1)}
                                </ul>
                            )}
                        </li>
                    );
                })}
                {childDocuments.map((document) => (
                    <li key={document.id}>
                        <button
                            type="button"
                            role="treeitem"
                            draggable
                            aria-selected={selectedDocId === document.id}
                            onClick={() => onDocClick(document)}
                            onContextMenu={(event) =>
                                openContextMenu(
                                    event,
                                    document.folder_id ?? null,
                                    undefined,
                                    document.id,
                                )
                            }
                            onDragStart={(event) => {
                                event.dataTransfer.setData(
                                    VERA_DOCUMENT_DRAG,
                                    document.id,
                                );
                                event.dataTransfer.effectAllowed = "move";
                            }}
                            className={`flex w-full items-center gap-2 rounded-sm py-1.5 pr-4 text-left transition-colors ${
                                selectedDocId === document.id
                                    ? "bg-gray-100 text-gray-900"
                                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                            }`}
                            style={{ paddingLeft }}
                        >
                            <FileTypeIcon
                                fileType={document.file_type}
                                className="h-3.5 w-3.5"
                            />
                            <span className="min-w-0 flex-1 truncate text-xs">
                                {document.filename}
                            </span>
                            <VersionChip
                                n={
                                    document.active_version_number ??
                                    document.latest_version_number
                                }
                            />
                        </button>
                    </li>
                ))}
            </>
        );
    };

    return (
        <ul
            role="tree"
            className={`relative h-full p-1 ${
                dragOverRoot && !dragOverFolderId
                    ? "ring-2 ring-inset ring-blue-400"
                    : ""
            }`}
            onContextMenu={(event) => openContextMenu(event, null)}
            onDragOver={(event) => {
                event.preventDefault();
                setDragOverRoot(true);
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDragOverRoot(false);
                }
            }}
            onDrop={(event) => {
                event.preventDefault();
                if (
                    event.dataTransfer.types.includes(VERA_DOCUMENT_DRAG) ||
                    event.dataTransfer.types.includes(VERA_FOLDER_DRAG)
                ) {
                    event.stopPropagation();
                    setDragOverRoot(false);
                    void handleDrop(null, event);
                }
            }}
        >
            {projectName && (
                <li className="flex items-center gap-2 px-2 py-1.5">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="truncate text-xs text-gray-500">
                        {projectName}
                    </span>
                </li>
            )}
            {renderLevel(null, 1)}
            {documents.length === 0 &&
                folders.length === 0 &&
                creatingIn === undefined && (
                    <li className="px-4 py-2 text-xs text-gray-400">
                        {t("common.status.empty")}
                    </li>
                )}
            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    role="menu"
                    className="fixed z-50 w-44 overflow-hidden rounded-lg border border-gray-100 bg-white text-xs shadow-lg"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    {onCreateFolder && !contextMenu.docId && (
                        <MenuButton
                            icon={<FolderPlus className="h-3.5 w-3.5" />}
                            label={t("common.actions.create")}
                            onClick={() => {
                                setCreatingIn(contextMenu.parentId);
                                setNewFolderName("");
                                if (contextMenu.parentId) {
                                    setExpandedIds(
                                        (current) =>
                                            new Set([
                                                ...current,
                                                contextMenu.parentId!,
                                            ]),
                                    );
                                }
                                setContextMenu(null);
                            }}
                        />
                    )}
                    {contextMenu.folderId && onRenameFolder && (
                        <MenuButton
                            label={t("common.actions.rename")}
                            onClick={() => {
                                const folder = folders.find(
                                    (item) => item.id === contextMenu.folderId,
                                );
                                setRenameValue(folder?.name ?? "");
                                setRenamingId(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        />
                    )}
                    {contextMenu.folderId && onDeleteFolder && (
                        <MenuButton
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                            label={t("common.actions.delete")}
                            danger
                            onClick={() => {
                                void onDeleteFolder(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        />
                    )}
                    {contextMenu.docId && onDeleteDoc && (
                        <MenuButton
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                            label={t("common.actions.delete")}
                            danger
                            onClick={() => {
                                void onDeleteDoc(contextMenu.docId!);
                                setContextMenu(null);
                            }}
                        />
                    )}
                </div>
            )}
        </ul>
    );
}

function MenuButton({
    label,
    icon,
    danger = false,
    onClick,
}: {
    label: string;
    icon?: React.ReactNode;
    danger?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${
                danger ? "text-red-600" : "text-gray-700"
            }`}
        >
            {icon}
            {label}
        </button>
    );
}
