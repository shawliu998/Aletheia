"use client";

import { FileText, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/app/components/shared/Modal";
import { useI18n } from "@/app/i18n";
import { listVeraProjectDocuments } from "@/app/lib/veraApi";
import {
  getVeraModelSettingsStatus,
  type VeraModelProfile,
} from "@/app/lib/veraModelSettingsApi";
import type {
  VeraTabularColumn,
  VeraTabularReviewCreateInput,
} from "@/app/lib/veraTabularApi";
import {
  listHiddenVeraWorkflows,
  listVeraWorkflows,
  type VeraWorkflow,
} from "@/app/lib/veraWorkflowApi";
import type {
  VeraDocumentWire,
  VeraProjectWire,
} from "@/app/lib/veraWireTypes";

function readyModel(profile: VeraModelProfile): boolean {
  return (
    profile.enabled &&
    profile.availability.selectable &&
    profile.connection_test.status === "passed"
  );
}

export function projectedContractReviewColumns(
  workflow: VeraWorkflow,
): VeraTabularColumn[] {
  return (workflow.columns_config ?? []).map((column) => ({
    index: column.index,
    name: column.name,
    prompt: column.prompt,
    format: column.format ?? "text",
    tags: column.tags ?? [],
  }));
}

export function ContractReviewModal({
  open,
  project,
  initialWorkflowId = null,
  creating = false,
  onClose,
  onCreate,
}: {
  open: boolean;
  project: Pick<
    VeraProjectWire,
    "id" | "name" | "status" | "default_model_profile_id"
  >;
  initialWorkflowId?: string | null;
  creating?: boolean;
  onClose: () => void;
  onCreate: (input: VeraTabularReviewCreateInput) => Promise<void>;
}) {
  const { errorMessage, t } = useI18n();
  const [title, setTitle] = useState("");
  const [workflows, setWorkflows] = useState<VeraWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [documents, setDocuments] = useState<VeraDocumentWire[]>([]);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [models, setModels] = useState<VeraModelProfile[]>([]);
  const [modelProfileId, setModelProfileId] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const formId = "vera-new-contract-review";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setTitle("");
      setWorkflowId("");
      setDocumentIds([]);
      setFailure(null);
      setLoading(true);
    });
    Promise.all([
      listVeraWorkflows("tabular", controller.signal),
      listHiddenVeraWorkflows(controller.signal),
      listVeraProjectDocuments(project.id, {}, controller.signal),
      getVeraModelSettingsStatus({ signal: controller.signal }),
    ])
      .then(([loadedWorkflows, hiddenWorkflowIds, loadedDocuments, settings]) => {
        if (controller.signal.aborted) return;
        const hidden = new Set(hiddenWorkflowIds);
        const availableWorkflows = loadedWorkflows.filter(
          (workflow) =>
            workflow.is_system &&
            !hidden.has(workflow.id) &&
            workflow.metadata.type === "tabular" &&
            (workflow.columns_config?.length ?? 0) > 0,
        );
        setWorkflows(availableWorkflows);
        const requestedWorkflow = availableWorkflows.find(
          (workflow) => workflow.id === initialWorkflowId,
        );
        if (requestedWorkflow) {
          setWorkflowId(requestedWorkflow.id);
          setTitle(requestedWorkflow.metadata.title);
        }
        setDocuments(loadedDocuments);
        const selectable = settings.models.filter(readyModel);
        setModels(selectable);
        setModelProfileId(
          selectable.find(
            (model) => model.id === project.default_model_profile_id,
          )?.id ??
            selectable.find(
              (model) =>
                model.id === settings.settings.default_model_profile_id,
            )?.id ??
            selectable[0]?.id ??
            "",
        );
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setWorkflows([]);
          setDocuments([]);
          setModels([]);
          setFailure(errorMessage(reason as Error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    errorMessage,
    initialWorkflowId,
    open,
    project.default_model_profile_id,
    project.id,
  ]);

  const workflow = workflows.find((item) => item.id === workflowId) ?? null;
  const columns = workflow ? projectedContractReviewColumns(workflow) : [];
  const readyDocuments = useMemo(
    () => documents.filter((document) => document.status === "ready"),
    [documents],
  );
  const maximumDocuments = Math.min(
    1_000,
    Math.floor(10_000 / Math.max(columns.length, 1)),
  );
  const invalid =
    project.status !== "active" ||
    !title.trim() ||
    !workflow ||
    columns.length === 0 ||
    documentIds.length === 0 ||
    documentIds.length > maximumDocuments ||
    !modelProfileId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid || submitting || creating || !workflow) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await onCreate({
        title: title.trim(),
        project_id: project.id,
        document_ids: documentIds,
        columns_config: columns,
        model_profile_id: modelProfileId,
        workflow_id: workflow.id,
      });
    } catch (reason) {
      setFailure(errorMessage(reason as Error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting && !creating) onClose();
      }}
      size="xl"
      breadcrumbs={[
        t("tabular.title"),
        t("workflows.contractReview.new.title"),
      ]}
      primaryAction={{
        label:
          submitting || creating
            ? t("common.status.saving")
            : t("workflows.contractReview.new.create"),
        type: "submit",
        form: formId,
        disabled: invalid || loading || submitting || creating,
        icon:
          submitting || creating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : undefined,
      }}
      cancelAction={{
        label: t("common.actions.cancel"),
        onClick: onClose,
        disabled: submitting || creating,
      }}
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="grid gap-5 pb-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"
      >
        <div className="min-w-0 space-y-4">
          {failure && (
            <p
              role="alert"
              className="rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-700"
            >
              {failure}
            </p>
          )}
          <label className="block space-y-1.5 text-xs font-medium text-gray-700">
            <span>{t("workflows.contractReview.new.name")}</span>
            <input
              autoFocus
              value={title}
              maxLength={240}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("workflows.contractReview.new.namePlaceholder")}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
            />
          </label>

          <label className="block space-y-1.5 text-xs font-medium text-gray-700">
            <span>{t("workflows.contractReview.new.playbook")}</span>
            <select
              value={workflowId}
              disabled={loading || workflows.length === 0}
              onChange={(event) => {
                const nextId = event.target.value;
                setWorkflowId(nextId);
                const nextWorkflow = workflows.find(
                  (item) => item.id === nextId,
                );
                if (nextWorkflow) setTitle(nextWorkflow.metadata.title);
              }}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400 disabled:opacity-50"
            >
              <option value="">
                {t("workflows.contractReview.new.choosePlaybook")}
              </option>
              {workflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.metadata.title}
                  {item.metadata.version ? ` · ${item.metadata.version}` : ""}
                </option>
              ))}
            </select>
          </label>

          {workflows.length === 0 && !loading && !failure && (
            <div className="rounded-xl border border-dashed border-gray-200 px-3 py-5 text-center text-xs text-gray-500">
              {t("workflows.contractReview.new.noPlaybooks")}
            </div>
          )}

          <label className="block space-y-1.5 text-xs font-medium text-gray-700">
            <span>{t("tabular.new.model")}</span>
            <select
              value={modelProfileId}
              disabled={loading || models.length === 0}
              onChange={(event) => setModelProfileId(event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400 disabled:opacity-50"
            >
              <option value="">{t("tabular.new.chooseModel")}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} · {model.model}
                </option>
              ))}
            </select>
            {models.length === 0 && !loading && (
              <span className="block font-normal text-amber-700">
                {t("tabular.new.noReadyModel")}
              </span>
            )}
          </label>

          {workflow && (
            <section
              aria-label={t("workflows.contractReview.new.checks")}
              className="rounded-2xl border border-gray-100 bg-gray-50/70 p-3"
            >
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gray-600" />
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-gray-900">
                    {workflow.metadata.title}
                  </h3>
                  {workflow.metadata.description && (
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                      {workflow.metadata.description}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-gray-400">
                    {[
                      workflow.metadata.practice,
                      ...(workflow.metadata.jurisdictions ?? []),
                      workflow.metadata.version,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
              <ol className="mt-3 max-h-56 space-y-1 overflow-y-auto">
                {columns.map((column, index) => (
                  <li
                    key={column.index}
                    className="rounded-lg border border-white bg-white/90 px-2.5 py-2"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-[11px] tabular-nums text-gray-400">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-800">
                          {column.name}
                        </p>
                        {column.tags.length > 0 && (
                          <p className="mt-0.5 truncate text-[11px] text-gray-400">
                            {column.tags.join(" · ")}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <section className="flex min-h-[360px] min-w-0 flex-col rounded-2xl border border-gray-100 bg-gray-50/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-medium text-gray-800">
                {t("workflows.contractReview.new.documents")}
              </h3>
              <p className="mt-0.5 text-[11px] text-gray-400">
                {t("tabular.new.readyDocumentsOnly")}
              </p>
            </div>
            {readyDocuments.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setDocumentIds(
                    documentIds.length ===
                      Math.min(readyDocuments.length, maximumDocuments)
                      ? []
                      : readyDocuments
                          .slice(0, maximumDocuments)
                          .map((document) => document.id),
                  )
                }
                className="text-xs text-gray-500 hover:text-gray-900"
              >
                {documentIds.length ===
                Math.min(readyDocuments.length, maximumDocuments)
                  ? t("tabular.new.clearSelection")
                  : t("tabular.new.selectAll")}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-white bg-white/80">
            {loading ? (
              <div className="flex h-full min-h-40 items-center justify-center text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : readyDocuments.length === 0 ? (
              <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-gray-400">
                <FileText className="h-6 w-6 text-gray-300" />
                {t("workflows.contractReview.new.noDocuments")}
              </div>
            ) : (
              readyDocuments.map((document) => {
                const selected = documentIds.includes(document.id);
                const canSelect =
                  selected || documentIds.length < maximumDocuments;
                return (
                  <label
                    key={document.id}
                    className={`flex items-center gap-3 border-b border-gray-50 px-3 py-2.5 text-xs last:border-b-0 ${
                      canSelect
                        ? "cursor-pointer hover:bg-gray-50"
                        : "cursor-not-allowed opacity-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!canSelect}
                      onChange={() =>
                        setDocumentIds((current) =>
                          selected
                            ? current.filter((id) => id !== document.id)
                            : [...current, document.id],
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-gray-700">
                      {document.filename}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <p className="mt-2 text-[11px] text-gray-400">
            {t("workflows.contractReview.new.selectedDocuments", {
              count: documentIds.length,
            })}
          </p>
          <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
            {t("workflows.contractReview.new.disclaimer")}
          </p>
        </section>
      </form>
    </Modal>
  );
}
