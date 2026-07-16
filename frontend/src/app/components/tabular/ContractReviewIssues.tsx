"use client";

import { AlertTriangle, CheckCircle2, Clock3, FileSearch } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "@/app/i18n";
import type {
  VeraTabularCell,
  VeraTabularReviewDetail,
} from "@/app/lib/veraTabularApi";

type IssueBucket = "red" | "yellow" | "grey" | "green" | "pending" | "error";

const BUCKET_ORDER: Record<IssueBucket, number> = {
  red: 0,
  yellow: 1,
  error: 2,
  grey: 3,
  pending: 4,
  green: 5,
};

const BUCKET_STYLE: Record<IssueBucket, string> = {
  red: "border-red-200 bg-red-50 text-red-800",
  yellow: "border-amber-200 bg-amber-50 text-amber-800",
  error: "border-rose-200 bg-rose-50 text-rose-800",
  grey: "border-slate-200 bg-slate-50 text-slate-700",
  pending: "border-blue-200 bg-blue-50 text-blue-700",
  green: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

export function contractReviewBucketFor(cell: VeraTabularCell): IssueBucket {
  if (cell.status === "error") return "error";
  if (cell.status === "pending" || cell.status === "generating") {
    return "pending";
  }
  return cell.content?.flag ?? "grey";
}

export function ContractReviewIssues({
  detail,
  search,
  onOpenCell,
}: {
  detail: VeraTabularReviewDetail;
  search: string;
  onOpenCell: (cell: VeraTabularCell) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<"all" | IssueBucket>("all");
  const documents = useMemo(
    () => new Map(detail.documents.map((document) => [document.id, document])),
    [detail.documents],
  );
  const columns = useMemo(
    () =>
      new Map(
        detail.review.columns_config.map((column) => [column.index, column]),
      ),
    [detail.review.columns_config],
  );
  const rows = useMemo(
    () =>
      detail.cells
        .map((cell) => ({
          cell,
          bucket: contractReviewBucketFor(cell),
          document: documents.get(cell.document_id),
          column: columns.get(cell.column_index),
        }))
        .filter((row) => row.document && row.column)
        .sort(
          (left, right) =>
            BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket] ||
            left.cell.column_index - right.cell.column_index,
        ),
    [columns, detail.cells, documents],
  );
  const counts = useMemo(() => {
    const next: Record<IssueBucket, number> = {
      red: 0,
      yellow: 0,
      grey: 0,
      green: 0,
      pending: 0,
      error: 0,
    };
    for (const row of rows) next[row.bucket] += 1;
    return next;
  }, [rows]);
  const filtered =
    filter === "all" ? rows : rows.filter((row) => row.bucket === filter);
  const query = search.trim().toLocaleLowerCase();
  const visible = query
    ? filtered.filter(
        (row) =>
          row.document?.filename.toLocaleLowerCase().includes(query) ||
          row.column?.name.toLocaleLowerCase().includes(query),
      )
    : filtered;

  if (detail.review.document_ids.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <FileSearch className="mx-auto h-8 w-8 text-gray-300" />
          <h2 className="mt-4 font-serif text-2xl text-gray-900">
            {t("workflows.contractReview.issues.noDocuments")}
          </h2>
          <p className="mt-2 text-xs leading-5 text-gray-500">
            {t("workflows.contractReview.issues.noDocumentsBody")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8fa] px-4 py-4 md:px-10 md:py-6">
      <div className="mx-auto w-full max-w-6xl">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(
            ["red", "yellow", "grey", "green", "pending", "error"] as const
          ).map((bucket) => (
            <button
              key={bucket}
              type="button"
              onClick={() => setFilter(filter === bucket ? "all" : bucket)}
              aria-pressed={filter === bucket}
              className={`rounded-xl border px-3 py-2 text-left transition ${
                filter === bucket
                  ? BUCKET_STYLE[bucket]
                  : "border-gray-200 bg-white text-gray-700"
              }`}
            >
              <span className="block text-lg font-semibold tabular-nums">
                {counts[bucket]}
              </span>
              <span className="block text-[11px]">
                {t(`workflows.contractReview.issues.buckets.${bucket}`)}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-xl text-gray-950">
              {t("workflows.contractReview.issues.title")}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {t("workflows.contractReview.issues.persistedOnly")}
            </p>
          </div>
          {filter !== "all" && (
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="self-start text-xs font-medium text-gray-500 hover:text-gray-900"
            >
              {t("workflows.contractReview.issues.clearFilter")}
            </button>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-gray-200 bg-white px-5 py-12 text-center">
            <Clock3 className="mx-auto h-7 w-7 text-gray-300" />
            <h3 className="mt-3 font-medium text-gray-900">
              {t("workflows.contractReview.issues.notRun")}
            </h3>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-gray-500">
              {t("workflows.contractReview.issues.notRunBody")}
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-emerald-100 bg-white px-5 py-10 text-center">
            <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-500" />
            <h3 className="mt-3 font-medium text-gray-900">
              {t("workflows.contractReview.issues.noMatching")}
            </h3>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-gray-500">
              {t("workflows.contractReview.issues.humanReview")}
            </p>
          </div>
        ) : (
          <ol className="mt-4 grid gap-3 lg:grid-cols-2">
            {visible.map(({ bucket, cell, column, document }) => (
              <li key={cell.id}>
                <button
                  type="button"
                  onClick={() => onOpenCell(cell)}
                  className="h-full w-full rounded-2xl border border-white/80 bg-white p-4 text-left shadow-sm transition hover:border-gray-200 hover:shadow-md"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${BUCKET_STYLE[bucket]}`}
                    >
                      {t(`workflows.contractReview.issues.buckets.${bucket}`)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium text-gray-950">
                        {column?.name}
                      </h3>
                      <p
                        className="mt-0.5 truncate text-[11px] text-gray-400"
                        title={document?.filename}
                      >
                        {document?.filename}
                      </p>
                    </div>
                  </div>
                  {cell.content?.summary ? (
                    <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-gray-700">
                      {cell.content.summary}
                    </p>
                  ) : cell.error ? (
                    <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-red-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {cell.error.message}
                    </p>
                  ) : (
                    <p className="mt-3 text-xs text-gray-400">
                      {t("workflows.contractReview.issues.noSummary")}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-gray-400">
                    {(column?.tags ?? []).map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-gray-50 px-1.5 py-0.5"
                      >
                        {tag}
                      </span>
                    ))}
                    <span className="ml-auto">
                      {t("workflows.contractReview.issues.sources", {
                        count: cell.sources.length,
                      })}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
