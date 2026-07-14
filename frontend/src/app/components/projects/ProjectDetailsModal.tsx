"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/projects/ProjectDetailsModal.tsx

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { Modal } from "@/app/components/shared/Modal";
import { useI18n } from "@/app/i18n";
import type { VeraProjectWire } from "@/app/lib/veraWireTypes";
import { useProjectModalA11y } from "./useProjectModalA11y";

export type ProjectDetailsMode = "details" | "delete";

interface ProjectDetailsModalProps {
  open: boolean;
  project: VeraProjectWire | null;
  initialMode?: ProjectDetailsMode;
  onClose: () => void;
  onSave: (
    values: { name: string; description: string | null },
    signal: AbortSignal,
  ) => Promise<void>;
  onArchive: (signal: AbortSignal) => Promise<void>;
  onUnarchive: (signal: AbortSignal) => Promise<void>;
  onDelete: (confirmName: string, signal: AbortSignal) => Promise<void>;
}

export function ProjectDetailsModal({
  open,
  project,
  initialMode = "details",
  onClose,
  onSave,
  onArchive,
  onUnarchive,
  onDelete,
}: ProjectDetailsModalProps) {
  const [mode, setMode] = useState<ProjectDetailsMode>(initialMode);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { t, errorMessage } = useI18n();

  useEffect(() => {
    if (!open || !project) return;
    setMode(initialMode);
    setNameDraft(project.name);
    setDescriptionDraft(project.description ?? "");
    setConfirmName("");
    setSaved(false);
    setError(null);
  }, [initialMode, open, project]);

  const handleClose = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setSaving(false);
    onClose();
  }, [onClose]);

  useProjectModalA11y(
    open,
    handleClose,
    contentRef,
    project?.name ?? t("projects.title"),
    mode,
  );
  useEffect(() => () => requestRef.current?.abort(), []);

  const trimmedName = nameDraft.trim();
  const trimmedDescription = descriptionDraft.trim();
  const hasChanges = useMemo(() => {
    if (!project) return false;
    return (
      trimmedName !== project.name ||
      trimmedDescription !== (project.description ?? "")
    );
  }, [project, trimmedDescription, trimmedName]);

  if (!project) return null;

  async function runOperation(
    operation: (signal: AbortSignal) => Promise<void>,
    fallback: string,
  ) {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await operation(controller.signal);
      if (!controller.signal.aborted) setSaved(true);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const localized = errorMessage(cause as Error);
        setError(localized || fallback);
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  function handleSave() {
    if (saving || !hasChanges || !trimmedName) return;
    void runOperation(
      (signal) =>
        onSave(
          {
            name: trimmedName,
            description: trimmedDescription || null,
          },
          signal,
        ),
      t("projects.errors.update"),
    );
  }

  function handleArchiveToggle() {
    if (saving) return;
    void runOperation(
      project?.status === "archived" ? onUnarchive : onArchive,
      t("projects.errors.update"),
    );
  }

  function handleDelete() {
    if (saving || confirmName !== project?.name) return;
    void runOperation(async (signal) => {
      await onDelete(confirmName, signal);
      if (!signal.aborted) handleClose();
    }, t("projects.errors.delete"));
  }

  const archiveLabel = `${
    project.status === "archived"
      ? t("common.actions.open")
      : t("common.actions.close")
  } · ${t("projects.title")}`;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      breadcrumbs={[
        t("projects.title"),
        project.name,
        mode === "delete"
          ? t("common.actions.delete")
          : t("common.actions.edit"),
      ]}
      secondaryAction={
        mode === "details"
          ? {
              label: archiveLabel,
              icon:
                project.status === "archived" ? (
                  <ArchiveRestore className="h-4 w-4" />
                ) : (
                  <Archive className="h-4 w-4" />
                ),
              onClick: handleArchiveToggle,
              disabled: saving,
            }
          : undefined
      }
      footerStatus={
        error ? (
          <span role="alert" className="text-sm text-red-600">
            {error}
          </span>
        ) : saved ? (
          <span className="text-sm text-gray-400">
            {t("common.status.saved")}
          </span>
        ) : null
      }
      primaryAction={
        mode === "details"
          ? {
              label: saving
                ? t("common.status.saving")
                : t("common.actions.save"),
              onClick: handleSave,
              disabled: saving || !hasChanges || !trimmedName,
            }
          : {
              label: saving
                ? t("common.status.processing")
                : t("projects.deleteConfirm.action"),
              icon: <Trash2 className="h-4 w-4" />,
              variant: "danger",
              onClick: handleDelete,
              disabled: saving || confirmName !== project.name,
            }
      }
      cancelAction={{
        label:
          mode === "delete"
            ? t("common.actions.back")
            : t("common.actions.cancel"),
        onClick:
          mode === "delete"
            ? () => {
                setMode("details");
                setConfirmName("");
                setError(null);
              }
            : handleClose,
        disabled: saving,
      }}
    >
      <div ref={contentRef} className="flex min-h-0 flex-1 flex-col gap-6 py-1">
        {mode === "details" ? (
          <>
            <div>
              <label
                htmlFor="vera-project-details-name"
                className="mb-1 block text-xs font-medium text-gray-500"
              >
                {t("projects.nameLabel")}
              </label>
              <input
                id="vera-project-details-name"
                data-project-modal-autofocus
                value={nameDraft}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  setSaved(false);
                  setError(null);
                }}
                disabled={saving}
                maxLength={240}
                placeholder={t("projects.namePlaceholder")}
                className="w-full border-0 border-b border-gray-100 bg-transparent px-0 py-2 text-2xl font-medium text-gray-900 outline-none transition-colors placeholder:text-gray-300 focus:border-gray-300 disabled:opacity-50"
              />
            </div>
            <div>
              <label
                htmlFor="vera-project-details-description"
                className="mb-1 block text-xs font-medium text-gray-500"
              >
                {t("projects.descriptionLabel")}
              </label>
              <textarea
                id="vera-project-details-description"
                value={descriptionDraft}
                onChange={(event) => {
                  setDescriptionDraft(event.target.value);
                  setSaved(false);
                  setError(null);
                }}
                disabled={saving}
                maxLength={2000}
                rows={5}
                placeholder={t("projects.descriptionPlaceholder")}
                className="w-full resize-none border-0 border-b border-gray-100 bg-transparent px-0 py-2 text-sm text-gray-600 outline-none transition-colors placeholder:text-gray-300 focus:border-gray-300 disabled:opacity-50"
              />
            </div>
            <div className="mt-auto border-t border-gray-100 pt-5">
              <p className="text-xs text-gray-400">
                {t("projects.deleteConfirm.body")}
              </p>
              <button
                type="button"
                onClick={() => {
                  setMode("delete");
                  setSaved(false);
                  setError(null);
                }}
                disabled={saving}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("projects.deleteConfirm.action")}
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-start justify-center py-12">
            <Trash2 className="mb-4 h-8 w-8 text-red-300" />
            <h2 className="font-serif text-2xl font-medium text-gray-900">
              {t("projects.deleteConfirm.title")}
            </h2>
            <p className="mt-2 max-w-md text-sm text-gray-500">
              {t("projects.deleteConfirm.body")}
            </p>
            <label
              htmlFor="vera-project-delete-confirm-name"
              className="mt-6 block text-xs font-medium text-gray-500"
            >
              {t("projects.deleteConfirm.namePrompt", {
                name: project.name,
              })}
            </label>
            <input
              id="vera-project-delete-confirm-name"
              data-project-modal-autofocus
              value={confirmName}
              onChange={(event) => {
                setConfirmName(event.target.value);
                setError(null);
              }}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              className="mt-2 w-full max-w-md rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-gray-400 disabled:opacity-50"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
