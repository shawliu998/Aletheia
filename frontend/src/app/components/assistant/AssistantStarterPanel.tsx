"use client";

import { useCallback, useState, type RefObject } from "react";
import { useI18n } from "@/app/i18n";
import type { ChatInputHandle } from "./ChatInput";
import {
  CustomExtractionFieldsDialog,
  type ExtractionField,
} from "./CustomExtractionFieldsDialog";

export function AssistantStarterPanel({
  inputRef,
  showReadyHint,
  scopeAvailable,
}: {
  inputRef: RefObject<ChatInputHandle | null>;
  showReadyHint: boolean;
  scopeAvailable: boolean;
}) {
  const { t, locale } = useI18n();
  const [customExtractionOpen, setCustomExtractionOpen] = useState(false);
  const starters = [
    {
      key: "contractReview" as const,
      label: t("assistant.starters.contractReview.label"),
      prompt: t("assistant.starters.contractReview.prompt"),
    },
    {
      key: "customExtraction" as const,
      label: t("assistant.starters.customExtraction.label"),
      prompt: t("assistant.starters.customExtraction.prompt"),
    },
    {
      key: "caseTimeline" as const,
      label: t("assistant.starters.caseTimeline.label"),
      prompt: t("assistant.starters.caseTimeline.prompt"),
    },
    {
      key: "legalMemo" as const,
      label: t("assistant.starters.legalMemo.label"),
      prompt: t("assistant.starters.legalMemo.prompt"),
    },
  ] as const;

  const startStarter = useCallback(
    (prompt: string, minimumDocuments: number) => {
      inputRef.current?.setMinimumDocuments(minimumDocuments);
      inputRef.current?.setPrompt(prompt);
      inputRef.current?.openDocumentPicker();
    },
    [inputRef],
  );

  const confirmCustomExtraction = useCallback(
    (fields: ExtractionField[]) => {
      const fieldList = fields
        .map(
          (field, index) =>
            `${index + 1}. ${field.name} | ${field.format} | ${field.instruction}`,
        )
        .join("\n");
      const prompt =
        locale === "zh-CN"
          ? `请从我选择的材料中提取以下字段，并生成一份可导出的结构化比较表。请严格按照字段名称、说明和格式执行。仅使用材料中有明确依据的信息；缺失内容标记为“未发现”，不确定内容列入待确认事项，不要推测。\n\n字段（名称 | 格式 | 提取说明）：\n${fieldList}`
          : `Extract the following fields from my selected materials and produce an exportable structured comparison table. Follow each field name, instruction, and format exactly. Use only information explicitly supported by the materials; mark missing content as “Not found”, list uncertainty for confirmation, and do not infer.\n\nFields (name | format | instruction):\n${fieldList}`;
      setCustomExtractionOpen(false);
      inputRef.current?.setMinimumDocuments(2);
      inputRef.current?.setPrompt(prompt);
      inputRef.current?.openDocumentPicker();
    },
    [inputRef, locale],
  );

  return (
    <>
      <div className="max-w-xl">
        <div className="flex flex-wrap justify-center gap-2">
          {starters.map((starter) => (
            <button
              key={starter.key}
              type="button"
              disabled={!scopeAvailable}
              onClick={() =>
                starter.key === "customExtraction"
                  ? setCustomExtractionOpen(true)
                  : startStarter(
                      starter.prompt,
                      starter.key === "legalMemo" ? 1 : 2,
                    )
              }
              className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starter.label}
            </button>
          ))}
        </div>
        {!scopeAvailable ? (
          <p className="mt-3 text-center text-xs leading-5 text-amber-800">
            {t("assistant.starters.matterScopeHint")}
          </p>
        ) : showReadyHint ? (
          <p className="mt-3 text-center text-xs leading-5 text-amber-800">
            {t("assistant.starters.matterReadyHint")}
          </p>
        ) : null}
      </div>
      {customExtractionOpen && (
        <CustomExtractionFieldsDialog
          onClose={() => setCustomExtractionOpen(false)}
          onConfirm={confirmCustomExtraction}
        />
      )}
    </>
  );
}
