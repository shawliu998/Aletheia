"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectsOverview.tsx

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FolderOpen } from "lucide-react";
import {
  archiveVeraProject,
  deleteVeraProject,
  listVeraProjects,
  unarchiveVeraProject,
  updateVeraProject,
} from "@/app/lib/veraApi";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import { useI18n } from "@/app/i18n";
import { NewProjectModal } from "./NewProjectModal";
import {
  ProjectDetailsModal,
  type ProjectDetailsMode,
} from "./ProjectDetailsModal";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import {
  RowActionMenuItems,
  RowActions,
} from "@/app/components/shared/RowActions";
import { PageHeader } from "@/app/components/vera-shell/PageHeader";
import {
  TABLE_CHECKBOX_CLASS,
  TABLE_STICKY_CELL_BG,
  SkeletonDot,
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";

type ProjectFilter = "all" | "active" | "archived";

export function ProjectsOverview() {
  const [projects, setProjects] = useState<VeraProjectWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailsProject, setDetailsProject] = useState<VeraProjectWire | null>(
    null,
  );
  const [detailsMode, setDetailsMode] = useState<ProjectDetailsMode>("details");
  const [activeFilter, setActiveFilter] = useState<ProjectFilter>("active");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [search, setSearch] = useState("");
  const actionsRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { t, formatDate, formatNumber } = useI18n();

  useEffect(() => {
    const controller = new AbortController();
    async function loadProjects() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setLoadError(null);
      try {
        const loaded = await listVeraProjects(controller.signal);
        if (controller.signal.aborted) return;
        const visible = loaded.filter(
          (project) => project.status !== "deleted",
        );
        setProjects(visible);
        setSelectedIds((current) =>
          current.filter((id) => visible.some((project) => project.id === id)),
        );
      } catch {
        if (controller.signal.aborted) return;
        setProjects([]);
        setLoadError(t("projects.errors.load"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadProjects();
    return () => controller.abort();
  }, [reloadVersion, t]);

  useEffect(() => {
    if (!actionsOpen) return;
    function handlePointer(event: MouseEvent) {
      if (!actionsRef.current?.contains(event.target as Node)) {
        setActionsOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setActionsOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [actionsOpen]);

  const query = search.trim().toLocaleLowerCase();
  const filtered = projects
    .filter((project) =>
      activeFilter === "all" ? true : project.status === activeFilter,
    )
    .filter(
      (project) =>
        !query ||
        project.name.toLocaleLowerCase().includes(query) ||
        (project.description ?? "").toLocaleLowerCase().includes(query),
    );

  const allSelected =
    filtered.length > 0 &&
    filtered.every((project) => selectedIds.includes(project.id));
  const someSelected =
    !allSelected &&
    filtered.some((project) => selectedIds.includes(project.id));
  const selectedProjects = projects.filter((project) =>
    selectedIds.includes(project.id),
  );
  const selectedActive = selectedProjects.filter(
    (project) => project.status === "active",
  );
  const selectedArchived = selectedProjects.filter(
    (project) => project.status === "archived",
  );

  function toggleAll() {
    setSelectedIds(allSelected ? [] : filtered.map((project) => project.id));
  }

  function toggleOne(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : [...current, id],
    );
  }

  function openDetails(
    project: VeraProjectWire,
    mode: ProjectDetailsMode = "details",
  ) {
    setDetailsMode(mode);
    setDetailsProject(project);
    setOperationError(null);
  }

  function mergeProject(updated: VeraProjectWire) {
    setProjects((current) =>
      current.map((project) =>
        project.id === updated.id ? { ...project, ...updated } : project,
      ),
    );
    setDetailsProject((current) =>
      current?.id === updated.id ? { ...current, ...updated } : current,
    );
  }

  async function applyBulkStatus(status: "active" | "archived") {
    const targets = status === "archived" ? selectedActive : selectedArchived;
    if (targets.length === 0 || bulkBusy) return;
    setActionsOpen(false);
    setBulkBusy(true);
    setOperationError(null);
    const results = await Promise.allSettled(
      targets.map((project) =>
        status === "archived"
          ? archiveVeraProject(project.id)
          : unarchiveVeraProject(project.id),
      ),
    );
    results.forEach((result) => {
      if (result.status === "fulfilled") mergeProject(result.value);
    });
    if (results.some((result) => result.status === "rejected")) {
      setOperationError(t("projects.errors.update"));
    }
    setSelectedIds([]);
    setBulkBusy(false);
  }

  const filters: { id: ProjectFilter; label: string }[] = [
    { id: "all", label: t("projects.all") },
    {
      id: "active",
      label: `${t("common.status.ready")} · ${t("projects.title")}`,
    },
    {
      id: "archived",
      label: `${t("common.actions.close")} · ${t("projects.title")}`,
    },
  ];

  const toolbarActions = (
    <>
      {operationError && (
        <p role="alert" className="mr-2 text-xs text-red-600">
          {operationError}
        </p>
      )}
      {selectedIds.length > 0 && (
        <div ref={actionsRef} className="relative">
          <button
            type="button"
            onClick={() => setActionsOpen((current) => !current)}
            disabled={bulkBusy}
            aria-expanded={actionsOpen}
            aria-controls="vera-project-bulk-actions"
            className="flex items-center gap-1 text-xs font-medium text-gray-700 transition-colors hover:text-gray-900 disabled:opacity-40"
          >
            {t("projects.title")}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {actionsOpen && (
            <div
              id="vera-project-bulk-actions"
              className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-gray-100 bg-white shadow-lg"
            >
              {selectedActive.length > 0 && (
                <button
                  type="button"
                  onClick={() => void applyBulkStatus("archived")}
                  className="w-full px-3 py-1.5 text-left text-xs text-gray-600 transition-colors hover:bg-gray-50"
                >
                  {`${t("common.actions.close")} · ${t("projects.title")}`}
                </button>
              )}
              {selectedArchived.length > 0 && (
                <button
                  type="button"
                  onClick={() => void applyBulkStatus("active")}
                  className="w-full px-3 py-1.5 text-left text-xs text-gray-600 transition-colors hover:bg-gray-50"
                >
                  {`${t("common.actions.open")} · ${t("projects.title")}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        actions={[
          {
            type: "search",
            value: search,
            onChange: setSearch,
            placeholder: t("common.actions.search"),
          },
          {
            type: "new",
            onClick: () => setModalOpen(true),
            title: t("projects.create"),
          },
        ]}
      >
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          {t("projects.title")}
        </h1>
      </PageHeader>

      <TableToolbar
        items={filters}
        active={activeFilter}
        onChange={(nextFilter) => {
          setActiveFilter(nextFilter);
          setSelectedIds([]);
          setActionsOpen(false);
        }}
        actions={toolbarActions}
      />

      <TableScrollArea>
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonDot />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) {
                    element.indeterminate = someSelected;
                  }
                }}
                onChange={toggleAll}
                aria-label={t("projects.all")}
                className={TABLE_CHECKBOX_CLASS}
              />
            )}
            <span>{t("common.fields.name")}</span>
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-80">
            {t("projects.descriptionLabel")}
          </TableHeaderCell>
          <TableHeaderCell className="w-24">
            {t("documents.title")}
          </TableHeaderCell>
          <TableHeaderCell className="w-24">
            {t("assistant.title")}
          </TableHeaderCell>
          <TableHeaderCell className="w-28">
            {t("workflows.title")}
          </TableHeaderCell>
          <TableHeaderCell className="w-28">
            {t("tabular.title")}
          </TableHeaderCell>
          <TableHeaderCell className="w-28">
            {t("common.status.ready")}
          </TableHeaderCell>
          <TableHeaderCell className="w-32">
            {t("common.fields.createdAt")}
          </TableHeaderCell>
          <TableHeaderCell className="w-8" />
        </TableHeaderRow>

        {loading ? (
          <TableBody>
            {[1, 2, 3].map((index) => (
              <TableRow key={index} interactive={false}>
                <TableStickyCell hover={false} bgClassName="bg-transparent">
                  <SkeletonDot />
                  <SkeletonLine className="h-3.5 w-48" />
                </TableStickyCell>
                <TableCell className="ml-auto w-80">
                  <SkeletonLine className="w-56" />
                </TableCell>
                {["documents", "chats"].map((key) => (
                  <TableCell key={key} className="w-24">
                    <SkeletonLine className="w-8" />
                  </TableCell>
                ))}
                {["workflows", "reviews"].map((key) => (
                  <TableCell key={key} className="w-28">
                    <SkeletonLine className="w-8" />
                  </TableCell>
                ))}
                <TableCell className="w-28">
                  <SkeletonLine className="w-14" />
                </TableCell>
                <TableCell className="w-32">
                  <SkeletonLine className="w-20" />
                </TableCell>
                <TableCell className="w-8" />
              </TableRow>
            ))}
          </TableBody>
        ) : loadError ? (
          <TableEmptyState>
            <FolderOpen className="mb-4 h-8 w-8 text-gray-300" />
            <p className="font-serif text-2xl font-medium text-gray-900">
              {t("projects.title")}
            </p>
            <p role="alert" className="mt-1 max-w-xs text-xs text-red-500">
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => setReloadVersion((current) => current + 1)}
              className="mt-4 text-xs font-medium text-gray-600 transition-colors hover:text-gray-900"
            >
              {t("common.actions.retry")}
            </button>
          </TableEmptyState>
        ) : filtered.length === 0 ? (
          <TableEmptyState>
            <FolderOpen className="mb-4 h-8 w-8 text-gray-300" />
            <p className="font-serif text-2xl font-medium text-gray-900">
              {t("projects.empty.title")}
            </p>
            <p className="mt-1 max-w-xs text-xs text-gray-400">
              {activeFilter === "archived"
                ? t("common.status.empty")
                : t("projects.empty.body")}
            </p>
            {activeFilter !== "archived" && (
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white shadow-md transition-colors hover:bg-gray-700"
              >
                {t("projects.empty.action")}
              </button>
            )}
          </TableEmptyState>
        ) : (
          <TableBody>
            {filtered.map((project) => {
              const selected = selectedIds.includes(project.id);
              const rowBackground = selected
                ? "bg-gray-50"
                : TABLE_STICKY_CELL_BG;
              return (
                <TableRow
                  key={project.id}
                  rightClickDropdown={(close) => (
                    <RowActionMenuItems
                      onClose={close}
                      onRename={() => openDetails(project)}
                      renameLabel={t("common.actions.edit")}
                      onDelete={() => openDetails(project, "delete")}
                      deleteLabel={t("projects.deleteConfirm.action")}
                    />
                  )}
                  onClick={() => router.push(`/projects/${project.id}`)}
                >
                  <TablePrimaryCell
                    bgClassName={rowBackground}
                    selected={selected}
                    onSelectionChange={() => toggleOne(project.id)}
                    checkboxTitle={project.name}
                    label={project.name}
                  />
                  <TableCell className="ml-auto w-80 pr-6">
                    {project.description || (
                      <span className="text-gray-300">—</span>
                    )}
                  </TableCell>
                  <TableCell className="w-24">
                    {formatNumber(project.document_count)}
                  </TableCell>
                  <TableCell className="w-24">
                    {formatNumber(project.chat_count)}
                  </TableCell>
                  <TableCell className="w-28">
                    {formatNumber(project.workflow_count)}
                  </TableCell>
                  <TableCell className="w-28">
                    {formatNumber(project.review_count)}
                  </TableCell>
                  <TableCell className="w-28">
                    <span
                      className={
                        project.status === "archived"
                          ? "text-gray-400"
                          : "text-emerald-700"
                      }
                    >
                      {project.status === "archived"
                        ? t("common.actions.close")
                        : t("common.status.ready")}
                    </span>
                  </TableCell>
                  <TableCell className="w-32">
                    {formatDate(project.created_at, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </TableCell>
                  <div
                    className="flex w-8 shrink-0 justify-end"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <RowActions
                      onRename={() => openDetails(project)}
                      renameLabel={t("common.actions.edit")}
                      onDelete={() => openDetails(project, "delete")}
                      deleteLabel={t("projects.deleteConfirm.action")}
                    />
                  </div>
                </TableRow>
              );
            })}
          </TableBody>
        )}
      </TableScrollArea>

      <NewProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(project) => {
          setProjects((current) => {
            const exists = current.some(
              (candidate) => candidate.id === project.id,
            );
            return exists
              ? current.map((candidate) =>
                  candidate.id === project.id
                    ? { ...candidate, ...project }
                    : candidate,
                )
              : [project, ...current];
          });
        }}
      />

      <ProjectDetailsModal
        open={Boolean(detailsProject)}
        project={detailsProject}
        initialMode={detailsMode}
        onClose={() => setDetailsProject(null)}
        onSave={async (values, signal) => {
          if (!detailsProject) return;
          mergeProject(
            await updateVeraProject(detailsProject.id, values, signal),
          );
        }}
        onArchive={async (signal) => {
          if (!detailsProject) return;
          mergeProject(await archiveVeraProject(detailsProject.id, signal));
        }}
        onUnarchive={async (signal) => {
          if (!detailsProject) return;
          mergeProject(await unarchiveVeraProject(detailsProject.id, signal));
        }}
        onDelete={async (confirmName, signal) => {
          if (!detailsProject) return;
          const id = detailsProject.id;
          await deleteVeraProject(id, confirmName, signal);
          setProjects((current) =>
            current.filter((project) => project.id !== id),
          );
          setSelectedIds((current) =>
            current.filter((projectId) => projectId !== id),
          );
        }}
      />
    </div>
  );
}
