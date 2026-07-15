"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Download,
  FileUp,
  History,
  Loader2,
  Quote,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import { VeraRichTextEditor } from "@/app/components/shared/VeraRichTextEditor";
import { useI18n } from "@/app/i18n";
import { VeraApiError } from "@/app/lib/veraApi";
import {
  exportVeraStudioDocx,
  getVeraStudioDocument,
  importVeraStudioDocx,
  listVeraStudioVersions,
  restoreVeraStudioVersion,
  saveVeraStudioDocument,
  type VeraStudioDocumentWire,
  type VeraStudioDocxWarningCode,
  type VeraStudioVersionsWire,
} from "@/app/lib/veraDocumentStudioApi";
import { ProjectSectionToolbar } from "./ProjectWorkspace";

interface Props {
  projectId: string;
  documentId: string;
}

type OperationErrorKind =
  | "load"
  | "save"
  | "import"
  | "export"
  | "restore"
  | "versions"
  | "clipboard"
  | "offline"
  | "conflict";

function isOfflineFailure(error: unknown) {
  return (
    error instanceof TypeError ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  );
}

function isVersionConflict(error: unknown) {
  return (
    error instanceof VeraApiError &&
    error.status === 409 &&
    error.code === "CONFLICT"
  );
}

function shortId(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function DocumentStudioView({ projectId, documentId }: Props) {
  const router = useRouter();
  const { t, formatDate, formatFileSize } = useI18n();
  const [document, setDocument] = useState<VeraStudioDocumentWire | null>(null);
  const [versions, setVersions] = useState<VeraStudioVersionsWire | null>(null);
  const [workingContent, setWorkingContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [historical, setHistorical] = useState<VeraStudioDocumentWire | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<OperationErrorKind | null>(null);
  const [versionError, setVersionError] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [docxWarnings, setDocxWarnings] = useState<{
    operation: "import" | "export";
    codes: VeraStudioDocxWarningCode[];
  } | null>(null);
  const historyControllerRef = useRef<AbortController | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const dirty = document !== null && workingContent !== savedContent;
  const displayDocument = historical ?? document;

  const errorText = useMemo(() => {
    if (errorKind === "offline") return t("studio.errors.offline");
    if (errorKind === "conflict") return t("studio.errors.conflict");
    if (errorKind === "restore") return t("studio.errors.restore");
    if (errorKind === "versions") return t("studio.errors.versions");
    if (errorKind === "clipboard") return t("studio.errors.clipboard");
    if (errorKind === "import") return t("studio.errors.import");
    if (errorKind === "export") return t("studio.errors.export");
    if (errorKind === "save") return t("studio.errors.save");
    if (errorKind === "load") return t("studio.errors.load");
    return null;
  }, [errorKind, t]);

  const docxWarningText = useCallback(
    (code: VeraStudioDocxWarningCode) => {
      switch (code) {
        case "DOCX_IMAGES_IGNORED":
          return t("studio.docx.warnings.DOCX_IMAGES_IGNORED");
        case "DOCX_FORMATTING_SIMPLIFIED":
          return t("studio.docx.warnings.DOCX_FORMATTING_SIMPLIFIED");
        case "DOCX_CONVERTER_WARNING":
          return t("studio.docx.warnings.DOCX_CONVERTER_WARNING");
        case "MARKDOWN_IMAGES_OMITTED":
          return t("studio.docx.warnings.MARKDOWN_IMAGES_OMITTED");
        case "MARKDOWN_HTML_AS_TEXT":
          return t("studio.docx.warnings.MARKDOWN_HTML_AS_TEXT");
        case "MARKDOWN_BLOCKQUOTE_SIMPLIFIED":
          return t("studio.docx.warnings.MARKDOWN_BLOCKQUOTE_SIMPLIFIED");
      }
    },
    [t],
  );

  const applyCurrent = useCallback(
    (next: VeraStudioDocumentWire) => {
      if (
        next.project_id !== projectId ||
        next.document_id !== documentId ||
        next.version.id !== next.current_version_id
      ) {
        throw new VeraApiError({
          status: 200,
          code: "INVALID_RESPONSE",
          message: "The Vera API returned an invalid current Studio document.",
        });
      }
      setDocument(next);
      setWorkingContent(next.content);
      setSavedContent(next.content);
      setHistorical(null);
    },
    [documentId, projectId],
  );

  const loadCurrent = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setErrorKind(null);
      setVersionError(false);
      try {
        const [documentResult, versionsResult] = await Promise.allSettled([
          getVeraStudioDocument(projectId, documentId, undefined, signal),
          listVeraStudioVersions(projectId, documentId, signal),
        ]);
        if (signal?.aborted) return;
        if (documentResult.status === "rejected") {
          throw documentResult.reason;
        }
        applyCurrent(documentResult.value);
        if (versionsResult.status === "fulfilled") {
          setVersions(versionsResult.value);
        } else {
          setVersions(null);
          setVersionError(true);
        }
      } catch (error) {
        if (signal?.aborted) return;
        setErrorKind(isOfflineFailure(error) ? "offline" : "load");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [applyCurrent, documentId, projectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadCurrent(controller.signal);
    return () => {
      controller.abort();
      historyControllerRef.current?.abort();
    };
  }, [loadCurrent]);

  const refreshVersions = useCallback(async () => {
    try {
      const next = await listVeraStudioVersions(projectId, documentId);
      setVersions(next);
      setVersionError(false);
    } catch {
      setVersionError(true);
    }
  }, [documentId, projectId]);

  const save = useCallback(async () => {
    if (
      !document ||
      saving ||
      restoring ||
      importing ||
      exporting ||
      historical ||
      !dirty
    ) {
      return;
    }
    setSaving(true);
    setErrorKind(null);
    try {
      const next = await saveVeraStudioDocument(projectId, documentId, {
        expected_version_id: document.current_version_id,
        content: workingContent,
        source: "user_upload",
        citation_anchor_ids: document.citation_anchors.map(
          (anchor) => anchor.id,
        ),
      });
      applyCurrent(next);
      await refreshVersions();
    } catch (error) {
      setErrorKind(
        isOfflineFailure(error)
          ? "offline"
          : isVersionConflict(error)
            ? "conflict"
            : "save",
      );
    } finally {
      setSaving(false);
    }
  }, [
    applyCurrent,
    dirty,
    document,
    documentId,
    exporting,
    historical,
    importing,
    projectId,
    refreshVersions,
    restoring,
    saving,
    workingContent,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const openVersion = useCallback(
    async (versionId: string) => {
      if (saving || restoring || importing || exporting) return;
      if (dirty) {
        setErrorKind("versions");
        return;
      }
      if (versionId === document?.current_version_id) {
        setHistorical(null);
        setErrorKind(null);
        return;
      }
      historyControllerRef.current?.abort();
      const controller = new AbortController();
      historyControllerRef.current = controller;
      setHistoryLoadingId(versionId);
      setErrorKind(null);
      try {
        const next = await getVeraStudioDocument(
          projectId,
          documentId,
          versionId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (
          next.project_id !== projectId ||
          next.document_id !== documentId ||
          next.version.id !== versionId
        ) {
          throw new VeraApiError({
            status: 200,
            code: "INVALID_RESPONSE",
            message: "The Vera API returned the wrong Studio version.",
          });
        }
        setHistorical(next);
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorKind(isOfflineFailure(error) ? "offline" : "versions");
        }
      } finally {
        if (!controller.signal.aborted) setHistoryLoadingId(null);
      }
    },
    [
      dirty,
      document?.current_version_id,
      documentId,
      exporting,
      importing,
      projectId,
      restoring,
      saving,
    ],
  );

  const restoreHistorical = useCallback(async () => {
    if (
      !document ||
      !historical ||
      restoring ||
      importing ||
      exporting ||
      dirty
    ) {
      return;
    }
    setRestoring(true);
    setErrorKind(null);
    try {
      const next = await restoreVeraStudioVersion(
        projectId,
        documentId,
        historical.version.id,
        { expected_current_version_id: document.current_version_id },
      );
      applyCurrent(next);
      await refreshVersions();
    } catch (error) {
      setErrorKind(
        isOfflineFailure(error)
          ? "offline"
          : isVersionConflict(error)
            ? "conflict"
            : "restore",
      );
    } finally {
      setRestoring(false);
    }
  }, [
    applyCurrent,
    dirty,
    document,
    documentId,
    exporting,
    historical,
    importing,
    projectId,
    refreshVersions,
    restoring,
  ]);

  const reloadLatest = useCallback(async () => {
    setReloadConfirmOpen(false);
    setLoading(true);
    try {
      const next = await getVeraStudioDocument(projectId, documentId);
      applyCurrent(next);
      setErrorKind(null);
      await refreshVersions();
    } catch (error) {
      setErrorKind(isOfflineFailure(error) ? "offline" : "load");
    } finally {
      setLoading(false);
    }
  }, [applyCurrent, documentId, projectId, refreshVersions]);

  const copyLocalDraft = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(workingContent);
    } catch {
      setErrorKind("clipboard");
    }
  }, [workingContent]);

  const canImportDocx =
    document?.capabilities.docx_import === true &&
    historical === null &&
    !dirty &&
    !saving &&
    !restoring &&
    !importing &&
    !exporting &&
    historyLoadingId === null &&
    errorKind !== "conflict";
  const canExportDocx =
    document?.capabilities.docx_export === true &&
    !saving &&
    !restoring &&
    !importing &&
    !exporting &&
    historyLoadingId === null;

  const importDocx = useCallback(async () => {
    if (!document || !pendingImportFile || !canImportDocx) return;
    const expectedVersionId = document.current_version_id;
    setImporting(true);
    setErrorKind(null);
    setDocxWarnings(null);
    try {
      const result = await importVeraStudioDocx(
        projectId,
        documentId,
        expectedVersionId,
        pendingImportFile,
      );
      applyCurrent(result.document);
      setDocxWarnings({ operation: "import", codes: result.warnings });
      await refreshVersions();
    } catch (error) {
      setErrorKind(
        isOfflineFailure(error)
          ? "offline"
          : isVersionConflict(error)
            ? "conflict"
            : "import",
      );
    } finally {
      setPendingImportFile(null);
      setImporting(false);
    }
  }, [
    applyCurrent,
    canImportDocx,
    document,
    documentId,
    pendingImportFile,
    projectId,
    refreshVersions,
  ]);

  const exportDocx = useCallback(async () => {
    if (!document || !canExportDocx) return;
    const selectedVersionId = (historical ?? document).version.id;
    setExporting(true);
    setErrorKind(null);
    setDocxWarnings(null);
    try {
      const result = await exportVeraStudioDocx(
        projectId,
        documentId,
        selectedVersionId,
      );
      const url = URL.createObjectURL(result.blob);
      try {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        anchor.rel = "noopener";
        window.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setDocxWarnings({ operation: "export", codes: result.warningCodes });
    } catch (error) {
      setErrorKind(isOfflineFailure(error) ? "offline" : "export");
    } finally {
      setExporting(false);
    }
  }, [canExportDocx, document, documentId, historical, projectId]);

  if (loading && !document) {
    return (
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectSectionToolbar />
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t("common.status.loading")}
        </div>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectSectionToolbar />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <AlertTriangle className="h-7 w-7 text-red-500" aria-hidden="true" />
          <p role="alert" className="max-w-lg text-sm text-red-700">
            {errorText ?? t("studio.errors.load")}
          </p>
          <button
            type="button"
            onClick={() => void loadCurrent()}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            {t("common.actions.retry")}
          </button>
        </div>
      </div>
    );
  }

  const visibleContent = historical?.content ?? workingContent;
  const visibleVersion = historical?.version ?? document.version;
  const versionItems = [...(versions?.versions ?? [])].sort(
    (left, right) => right.version_number - left.version_number,
  );

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectSectionToolbar />
      <main className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8fa]" aria-labelledby="studio-title">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 md:px-8 md:py-6">
          <header className="flex flex-col gap-3 rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-sm backdrop-blur-xl sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <button
                type="button"
                onClick={() => router.push(`/projects/${projectId}`)}
                aria-label={t("studio.back")}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <div className="min-w-0">
                <h1 id="studio-title" className="truncate text-base font-semibold text-gray-950">
                  {document.title}
                </h1>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span>
                    {historical
                      ? t("studio.historicalVersion", {
                          version: visibleVersion.version_number,
                        })
                      : t("studio.currentVersion", {
                          version: visibleVersion.version_number,
                        })}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span aria-live="polite" className="inline-flex items-center gap-1">
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : dirty ? (
                      <Clock3 className="h-3 w-3 text-amber-500" aria-hidden="true" />
                    ) : (
                      <Check className="h-3 w-3 text-emerald-600" aria-hidden="true" />
                    )}
                    {saving
                      ? t("studio.saving")
                      : dirty
                        ? t("studio.unsaved")
                        : t("studio.saved")}
                  </span>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <input
                ref={importInputRef}
                type="file"
                hidden
                tabIndex={-1}
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/octet-stream"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  event.currentTarget.value = "";
                  if (file && canImportDocx) {
                    setPendingImportFile(file);
                    setErrorKind(null);
                  }
                }}
              />
              {document.capabilities.docx_import === true && !historical && (
                <button
                  type="button"
                  disabled={!canImportDocx}
                  onClick={() => importInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {importing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {importing ? t("studio.docx.importing") : t("studio.docx.import")}
                </button>
              )}
              {document.capabilities.docx_export === true && (
                <button
                  type="button"
                  disabled={!canExportDocx}
                  onClick={() => void exportDocx()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {exporting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {exporting ? t("studio.docx.exporting") : t("studio.docx.export")}
                </button>
              )}
              {historical ? (
                <>
                  <button
                    type="button"
                    onClick={() => setHistorical(null)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {t("studio.current")}
                  </button>
                  <button
                    type="button"
                    disabled={restoring || importing || exporting || dirty}
                    onClick={() => void restoreHistorical()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {restoring ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {restoring ? t("studio.restoring") : t("studio.restore")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={!dirty || saving || restoring || importing || exporting}
                  onClick={() => void save()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {saving ? t("studio.saving") : t("studio.save")}
                </button>
              )}
            </div>
          </header>

          {dirty && document.capabilities.docx_export === true && !historical && (
            <p
              role="status"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900"
            >
              {t("studio.docx.exportSavedOnly")}
            </p>
          )}

          {docxWarnings && docxWarnings.codes.length > 0 && (
            <section
              role="status"
              aria-live="polite"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950"
            >
              <h2 className="text-xs font-semibold">
                {docxWarnings.operation === "import"
                  ? t("studio.docx.importWarnings")
                  : t("studio.docx.exportWarnings")}
              </h2>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-5">
                {docxWarnings.codes.map((code) => (
                  <li key={code}>{docxWarningText(code)}</li>
                ))}
              </ul>
            </section>
          )}

          {errorText && (
            <div
              role="alert"
              className={`flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center ${
                errorKind === "conflict"
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{errorText}</span>
              {errorKind === "conflict" && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyLocalDraft()}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium"
                  >
                    <Copy className="h-3 w-3" aria-hidden="true" />
                    {t("studio.copyLocal")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReloadConfirmOpen(true)}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-900 px-2.5 py-1.5 text-xs font-medium text-white"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    {t("studio.reloadLatest")}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="grid min-h-[36rem] gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section className="min-h-[32rem] overflow-hidden" aria-label={t("studio.editorLabel")}>
              <VeraRichTextEditor
                value={visibleContent}
                onChange={historical || importing ? undefined : setWorkingContent}
                readOnly={historical !== null || importing}
                ariaLabel={t("studio.editorLabel")}
                maxLength={2_000_000}
              />
            </section>

            <aside className="grid content-start gap-4" aria-label={t("studio.versions")}>
              <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
                  <History className="h-4 w-4 text-gray-500" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("studio.versions")}
                  </h2>
                  {versionError && (
                    <button
                      type="button"
                      onClick={() => void refreshVersions()}
                      aria-label={t("common.actions.retry")}
                      className="ml-auto text-red-600 hover:text-red-800"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {versionError && (
                  <p role="alert" className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
                    {t("studio.errors.versions")}
                  </p>
                )}
                <ol className="max-h-72 overflow-y-auto p-2">
                  {versionItems.map((version) => {
                    const current = version.id === document.current_version_id;
                    const selected = version.id === visibleVersion.id;
                    return (
                      <li key={version.id}>
                        <button
                          type="button"
                          disabled={
                            historyLoadingId !== null ||
                            saving ||
                            restoring ||
                            importing ||
                            exporting ||
                            (dirty && !current)
                          }
                          aria-current={selected ? "true" : undefined}
                          aria-label={t("studio.viewVersion", {
                            version: version.version_number,
                          })}
                          onClick={() => void openVersion(version.id)}
                          className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            selected ? "bg-gray-100" : "hover:bg-gray-50"
                          }`}
                        >
                          {historyLoadingId === version.id ? (
                            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" aria-hidden="true" />
                          ) : (
                            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-gray-100 px-1 text-[10px] font-semibold text-gray-600">
                              v{version.version_number}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1 text-xs font-medium text-gray-800">
                              {version.source}
                              {current && (
                                <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                                  {t("studio.current")}
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-gray-400">
                              {formatDate(version.created_at)} · {formatFileSize(version.size_bytes)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>

              <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
                <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-3">
                  <Quote className="h-4 w-4 text-gray-500" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-gray-900">
                    {t("studio.citations")}
                  </h2>
                  <span className="ml-auto text-xs text-gray-400">
                    {displayDocument?.citation_anchors.length ?? 0}
                  </span>
                </div>
                {displayDocument && displayDocument.citation_anchors.length > 0 ? (
                  <ol className="max-h-96 space-y-2 overflow-y-auto p-3">
                    {displayDocument.citation_anchors.map((anchor) => (
                      <li key={anchor.id} className="rounded-xl bg-gray-50 p-3">
                        <p className="text-xs leading-5 text-gray-700">
                          “{anchor.exact_quote}”
                        </p>
                        <p
                          className="mt-2 truncate font-mono text-[10px] text-gray-400"
                          title={anchor.snapshot_id}
                        >
                          {t("studio.sourceSnapshot", {
                            id: shortId(anchor.snapshot_id),
                          })}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="px-4 py-6 text-center text-xs text-gray-400">
                    {t("studio.noCitations")}
                  </p>
                )}
              </section>
            </aside>
          </div>
        </div>
      </main>

      <ConfirmPopup
        open={pendingImportFile !== null}
        title={t("studio.docx.confirm.title")}
        message={t("studio.docx.confirm.body", {
          name: pendingImportFile?.name ?? "",
        })}
        confirmLabel={t("studio.docx.confirm.action")}
        confirmStatus={importing ? "loading" : "idle"}
        confirmDisabled={!canImportDocx}
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={importing}
        onCancel={() => {
          if (!importing) setPendingImportFile(null);
        }}
        onConfirm={() => void importDocx()}
      />

      <ConfirmPopup
        open={reloadConfirmOpen}
        title={t("studio.reloadConfirm.title")}
        message={t("studio.reloadConfirm.body")}
        confirmLabel={t("studio.reloadConfirm.action")}
        confirmStatus={loading ? "loading" : "idle"}
        cancelLabel={t("common.actions.cancel")}
        cancelDisabled={loading}
        onCancel={() => {
          if (!loading) setReloadConfirmOpen(false);
        }}
        onConfirm={() => void reloadLatest()}
      />
    </div>
  );
}
