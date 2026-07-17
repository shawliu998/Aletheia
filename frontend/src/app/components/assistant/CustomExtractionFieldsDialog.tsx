"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import { useI18n } from "@/app/i18n";

const MIN_FIELDS = 1;
const MAX_FIELDS = 15;
const DEFAULT_FIELD_KEYS = [
  "party",
  "signingDate",
  "contractAmount",
  "paymentTerm",
  "terminationRight",
  "jurisdictionCourt",
] as const;
const FIELD_FORMATS = ["text", "date", "number", "boolean"] as const;

export type ExtractionField = Readonly<{
  name: string;
  instruction: string;
  format: (typeof FIELD_FORMATS)[number];
}>;

type EditableExtractionField = ExtractionField & Readonly<{ id: string }>;

export function CustomExtractionFieldsDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (fields: ExtractionField[]) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const nextFieldId = useRef(0);
  const defaultFields = useMemo<EditableExtractionField[]>(
    () =>
      DEFAULT_FIELD_KEYS.map((key) => ({
        id: `default-${key}`,
        name: t(`assistant.customExtraction.fields.${key}.name`),
        instruction: t(`assistant.customExtraction.fields.${key}.instruction`),
        format:
          key === "signingDate"
            ? "date"
            : key === "contractAmount"
              ? "number"
              : "text",
      })),
    [t],
  );
  const [fields, setFields] =
    useState<EditableExtractionField[]>(defaultFields);

  useEffect(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const cleanFields = fields
    .map(({ name, instruction, format }) => ({
      name: name.trim(),
      instruction: instruction.trim(),
      format,
    }))
    .filter((field) => field.name && field.instruction);
  const normalizedNames = cleanFields.map((field) =>
    field.name.toLocaleLowerCase(),
  );
  const duplicateNames =
    new Set(normalizedNames).size !== normalizedNames.length;
  const valid =
    cleanFields.length === fields.length &&
    fields.length >= 1 &&
    !duplicateNames;

  const updateField = (
    id: string,
    update: Partial<Omit<EditableExtractionField, "id">>,
  ) =>
    setFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, ...update } : field,
      ),
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-gray-950/35 p-3 sm:items-center sm:justify-center sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl sm:p-6"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-gray-950">
              {t("assistant.customExtraction.title")}
            </h2>
            <p className="mt-1 text-sm leading-5 text-gray-600">
              {t("assistant.customExtraction.description")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            aria-label={t("common.actions.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          {t("assistant.customExtraction.readyHint")}
        </p>
        <div className="mt-4 space-y-3">
          {fields.map((field, index) => (
            <fieldset
              key={field.id}
              className="rounded-xl border border-gray-200 p-3"
            >
              <legend className="px-1 text-xs font-medium text-gray-600">
                {t("assistant.customExtraction.fieldLabel", {
                  number: index + 1,
                })}
              </legend>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                <input
                  ref={index === 0 ? inputRef : undefined}
                  value={field.name}
                  maxLength={120}
                  onChange={(event) =>
                    updateField(field.id, { name: event.target.value })
                  }
                  placeholder={t("assistant.customExtraction.namePlaceholder")}
                  aria-label={t("assistant.customExtraction.fieldName", {
                    number: index + 1,
                  })}
                  className="min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/20"
                />
                <select
                  value={field.format}
                  onChange={(event) =>
                    updateField(field.id, {
                      format: event.target.value as ExtractionField["format"],
                    })
                  }
                  aria-label={t("assistant.customExtraction.fieldFormat", {
                    number: index + 1,
                  })}
                  className="rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/20"
                >
                  {FIELD_FORMATS.map((format) => (
                    <option key={format} value={format}>
                      {t(`assistant.customExtraction.formats.${format}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={fields.length <= MIN_FIELDS}
                  onClick={() =>
                    setFields((current) =>
                      current.filter((item) => item.id !== field.id),
                    )
                  }
                  className="rounded-lg border border-gray-300 p-2 text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={t("assistant.customExtraction.removeField", {
                    number: index + 1,
                  })}
                >
                  <Minus className="h-4 w-4" />
                </button>
              </div>
              <textarea
                value={field.instruction}
                maxLength={4000}
                onChange={(event) =>
                  updateField(field.id, { instruction: event.target.value })
                }
                rows={2}
                placeholder={t(
                  "assistant.customExtraction.instructionPlaceholder",
                )}
                aria-label={t("assistant.customExtraction.fieldInstruction", {
                  number: index + 1,
                })}
                className="mt-2 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900/20"
              />
            </fieldset>
          ))}
        </div>
        {duplicateNames && (
          <p className="mt-3 text-xs text-red-600" role="alert">
            {t("assistant.customExtraction.duplicateNames")}
          </p>
        )}
        <button
          type="button"
          disabled={fields.length >= MAX_FIELDS}
          onClick={() =>
            setFields((current) => [
              ...current,
              {
                id: `custom-${++nextFieldId.current}`,
                name: "",
                instruction: "",
                format: "text",
              },
            ])
          }
          className="mt-3 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
          {t("assistant.customExtraction.addField")}
        </button>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            {t("common.actions.cancel")}
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => onConfirm(cleanFields)}
            className="rounded-lg bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("assistant.customExtraction.confirm")}
          </button>
        </div>
      </section>
    </div>
  );
}
