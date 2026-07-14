"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/FileDirectory.tsx
import { useId, useMemo, useState } from "react";
import {
    Check,
    ChevronDown,
    ChevronRight,
    Folder,
    FolderOpen,
    Loader2,
    Search,
    X,
} from "lucide-react";
import { useI18n } from "@/app/i18n";
import type {
    VeraDocumentWire,
    VeraProjectWire,
} from "@/app/lib/veraWireTypes";
import { FileTypeIcon } from "./FileTypeIcon";
import { VersionChip } from "./VersionChip";

export function DocFileIcon({ fileType }: { fileType: string | null }) {
    return <FileTypeIcon fileType={fileType} className="h-3.5 w-3.5" />;
}

interface FileDirectoryProps {
    standaloneDocs: VeraDocumentWire[];
    directoryProjects: VeraProjectWire[];
    loading: boolean;
    selectedIds: Set<string>;
    onChange: (ids: Set<string>) => void;
    allowMultiple?: boolean;
    forceExpanded?: boolean;
    uploadingFilenames?: string[];
    searchable?: boolean;
    searchAutoFocus?: boolean;
    showProjectTabs?: boolean;
}

export function FileDirectory({
    standaloneDocs,
    directoryProjects,
    loading,
    selectedIds,
    onChange,
    allowMultiple = true,
    forceExpanded = false,
    uploadingFilenames = [],
    searchable = false,
    searchAutoFocus = false,
    showProjectTabs,
}: FileDirectoryProps) {
    const { t, formatDate } = useI18n();
    const searchId = useId();
    const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
        new Set(),
    );
    const [selectedTab, setSelectedTab] = useState<"files" | "projects">(
        "files",
    );
    const [search, setSearch] = useState("");
    const query = search.trim().toLocaleLowerCase();
    const showTabs = showProjectTabs ?? directoryProjects.length > 0;
    const activeTab = showTabs ? selectedTab : "files";

    const visibleStandaloneDocs = useMemo(
        () =>
            query
                ? standaloneDocs.filter((document) =>
                      document.filename.toLocaleLowerCase().includes(query),
                  )
                : standaloneDocs,
        [query, standaloneDocs],
    );
    const visibleProjects = useMemo(
        () =>
            query
                ? directoryProjects
                      .map((project) => ({
                          ...project,
                          documents: project.documents.filter(
                              (document) =>
                                  project.name
                                      .toLocaleLowerCase()
                                      .includes(query) ||
                                  document.filename
                                      .toLocaleLowerCase()
                                      .includes(query),
                          ),
                      }))
                      .filter(
                          (project) =>
                              project.name
                                  .toLocaleLowerCase()
                                  .includes(query) ||
                              project.documents.length > 0,
                      )
                : directoryProjects,
        [directoryProjects, query],
    );
    const visibleUploading = query
        ? uploadingFilenames.filter((filename) =>
              filename.toLocaleLowerCase().includes(query),
          )
        : uploadingFilenames;

    const toggle = (documentId: string) => {
        if (!allowMultiple) {
            onChange(new Set([documentId]));
            return;
        }
        const next = new Set(selectedIds);
        if (next.has(documentId)) next.delete(documentId);
        else next.add(documentId);
        onChange(next);
    };

    const toggleProject = (projectId: string) => {
        if (forceExpanded) return;
        setExpandedProjects((current) => {
            const next = new Set(current);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col space-y-2 rounded-sm">
            {searchable && (
                <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                    <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden="true" />
                    <label htmlFor={searchId} className="sr-only">
                        {t("common.actions.search")}
                    </label>
                    <input
                        id={searchId}
                        type="search"
                        value={search}
                        autoFocus={searchAutoFocus}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t("common.actions.search")}
                        className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
                    />
                    {search && (
                        <button
                            type="button"
                            onClick={() => setSearch("")}
                            aria-label={t("common.actions.close")}
                            className="text-gray-400 hover:text-gray-600"
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    )}
                </div>
            )}

            {showTabs && (
                <div className="flex self-start rounded-lg bg-gray-100 p-0.5">
                    {([
                        ["files", t("documents.title")],
                        ["projects", t("projects.title")],
                    ] as const).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setSelectedTab(value)}
                            aria-pressed={activeTab === value}
                            className={`rounded-md px-3 py-1 text-xs transition-colors ${
                                activeTab === value
                                    ? "bg-white text-gray-900 shadow-sm"
                                    : "text-gray-500 hover:text-gray-800"
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {loading ? (
                    [60, 45, 75, 55, 40].map((width) => (
                        <div
                            key={width}
                            className="flex items-center gap-2 rounded-md px-2 py-2"
                            aria-label={t("common.status.loading")}
                        >
                            <div className="h-3.5 w-3.5 shrink-0 rounded border border-gray-200" />
                            <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded bg-gray-100" />
                            <div
                                className="h-3 animate-pulse rounded bg-gray-100"
                                style={{ width: `${width}%` }}
                            />
                        </div>
                    ))
                ) : activeTab === "files" ? (
                    <>
                        {visibleUploading.map((filename) => (
                            <div
                                key={filename}
                                className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs"
                            >
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" />
                                <span className="min-w-0 flex-1 truncate text-gray-500">
                                    {filename}
                                </span>
                                <span className="text-gray-300">
                                    {t("common.status.processing")}
                                </span>
                            </div>
                        ))}
                        {visibleStandaloneDocs.map((document) => (
                            <DocumentChoice
                                key={document.id}
                                document={document}
                                selected={selectedIds.has(document.id)}
                                onClick={() => toggle(document.id)}
                                formattedDate={
                                    document.created_at
                                        ? formatDate(document.created_at)
                                        : null
                                }
                            />
                        ))}
                        {visibleStandaloneDocs.length === 0 &&
                            visibleUploading.length === 0 && (
                                <EmptyDirectory />
                            )}
                    </>
                ) : visibleProjects.length === 0 ? (
                    <EmptyDirectory />
                ) : (
                    visibleProjects.map((project) => {
                        const expanded =
                            forceExpanded ||
                            Boolean(query) ||
                            expandedProjects.has(project.id);
                        return (
                            <div key={project.id}>
                                <button
                                    type="button"
                                    onClick={() => toggleProject(project.id)}
                                    aria-expanded={expanded}
                                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-all hover:bg-gray-100/70"
                                >
                                    {expanded ? (
                                        <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" />
                                    ) : (
                                        <ChevronRight className="h-3 w-3 shrink-0 text-gray-400" />
                                    )}
                                    {expanded ? (
                                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                    ) : (
                                        <Folder className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                    )}
                                    <span className="min-w-0 flex-1 truncate font-medium text-gray-700">
                                        {project.name}
                                    </span>
                                    <span className="shrink-0 text-gray-400">
                                        {project.documents.length}
                                    </span>
                                </button>
                                {expanded &&
                                    (project.documents.length === 0 ? (
                                        <EmptyDirectory inset />
                                    ) : (
                                        project.documents.map((document) => (
                                            <DocumentChoice
                                                key={document.id}
                                                document={document}
                                                selected={selectedIds.has(document.id)}
                                                onClick={() => toggle(document.id)}
                                                inset
                                                formattedDate={
                                                    document.created_at
                                                        ? formatDate(document.created_at)
                                                        : null
                                                }
                                            />
                                        ))
                                    ))}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

function DocumentChoice({
    document,
    selected,
    onClick,
    inset = false,
    formattedDate,
}: {
    document: VeraDocumentWire;
    selected: boolean;
    onClick: () => void;
    inset?: boolean;
    formattedDate: string | null;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            className={`flex w-full items-center gap-2 rounded-md py-2 pr-2 text-left text-xs transition-all ${
                inset ? "pl-7" : "pl-2"
            } ${selected ? "bg-gray-100" : "hover:bg-gray-100/70"}`}
        >
            <span
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                    selected
                        ? "border-gray-900 bg-gray-900"
                        : "border-gray-300"
                }`}
            >
                {selected && <Check className="h-2.5 w-2.5 text-white" />}
            </span>
            <DocFileIcon fileType={document.file_type} />
            <span className="min-w-0 flex-1 truncate text-gray-700">
                {document.filename}
            </span>
            <VersionChip
                n={
                    document.active_version_number ??
                    document.latest_version_number
                }
            />
            {formattedDate && (
                <span className="shrink-0 text-gray-300">{formattedDate}</span>
            )}
        </button>
    );
}

function EmptyDirectory({ inset = false }: { inset?: boolean }) {
    const { t } = useI18n();
    return (
        <p
            className={`py-8 text-center text-sm text-gray-400 ${
                inset ? "pl-7 text-left" : ""
            }`}
        >
            {t("common.status.empty")}
        </p>
    );
}
