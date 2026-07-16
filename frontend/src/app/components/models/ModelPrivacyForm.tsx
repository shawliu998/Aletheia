"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";
import { accountGlassButtonClassName } from "@/app/(pages)/settings/accountStyles";
import { toVeraSettingsFailure } from "@/app/contexts/VeraSettingsContext";
import { useI18n } from "@/app/i18n";
import { VeraApiError } from "@/app/lib/veraApi";
import {
  getVeraModelPrivacyDeclaration,
  updateVeraModelPrivacyDeclaration,
  VERA_MODEL_EXECUTION_LOCATIONS,
  VERA_MODEL_RETENTION_VALUES,
  VERA_MODEL_TRAINING_USE_VALUES,
  type VeraModelPrivacyDeclaration,
  type VeraModelPrivacyDeclarationInput,
  type VeraModelProfile,
} from "@/app/lib/veraModelSettingsApi";

type Draft = {
  executionLocation: VeraModelPrivacyDeclarationInput["execution_location"] | "";
  retention: VeraModelPrivacyDeclarationInput["retention"] | "";
  trainingUse: VeraModelPrivacyDeclarationInput["training_use"] | "";
  sensitiveDataAllowed: boolean | null;
};

const EMPTY_DRAFT: Draft = {
  executionLocation: "",
  retention: "",
  trainingUse: "",
  sensitiveDataAllowed: null,
};

function draftFrom(declaration: VeraModelPrivacyDeclaration): Draft {
  return {
    executionLocation: declaration.execution_location,
    retention: declaration.retention,
    trainingUse: declaration.training_use,
    sensitiveDataAllowed: declaration.sensitive_data_allowed,
  };
}

function completeInput(draft: Draft): VeraModelPrivacyDeclarationInput | null {
  if (
    !draft.executionLocation ||
    !draft.retention ||
    !draft.trainingUse ||
    draft.sensitiveDataAllowed === null
  ) {
    return null;
  }
  return {
    execution_location: draft.executionLocation,
    retention: draft.retention,
    training_use: draft.trainingUse,
    sensitive_data_allowed: draft.sensitiveDataAllowed,
  };
}

export function ModelPrivacyForm({ profile }: { profile: VeraModelProfile }) {
  const { t, errorMessage, formatDate } = useI18n();
  const [declaration, setDeclaration] =
    useState<VeraModelPrivacyDeclaration | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [undeclared, setUndeclared] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDeclaration(null);
    setDraft(EMPTY_DRAFT);
    setUndeclared(false);
    setLoadFailed(false);
    setFailure(null);
    setSaved(false);
    getVeraModelPrivacyDeclaration(profile.id, { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setDeclaration(loaded);
        setDraft(draftFrom(loaded));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof VeraApiError && cause.status === 404) {
          setUndeclared(true);
          return;
        }
        setLoadFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [profile.id]);

  const input = useMemo(() => completeInput(draft), [draft]);
  const changed = Boolean(
    input &&
      (!declaration ||
        JSON.stringify(input) !==
          JSON.stringify({
            execution_location: declaration.execution_location,
            retention: declaration.retention,
            training_use: declaration.training_use,
            sensitive_data_allowed: declaration.sensitive_data_allowed,
          })),
  );
  const unknownDenies =
    draft.retention === "unknown" || draft.trainingUse === "unknown";

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFailure(null);
    setSaved(false);
  };

  const save = async () => {
    if (!input || !changed || saving) return;
    setSaving(true);
    setFailure(null);
    setSaved(false);
    try {
      const next = await updateVeraModelPrivacyDeclaration(profile.id, input);
      setDeclaration(next);
      setDraft(draftFrom(next));
      setUndeclared(false);
      setSaved(true);
    } catch (cause) {
      setFailure(errorMessage(toVeraSettingsFailure(cause)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label={`${profile.name} · ${t("settings.models.privacy.title")}`}
      className="rounded-xl border border-gray-200 p-4 dark:border-white/10"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
        <div>
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t("settings.models.privacy.title")}
          </h4>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t("settings.models.privacy.description")}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-gray-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("settings.models.privacy.loading")}
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {(undeclared || loadFailed) && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t(
                loadFailed
                  ? "settings.models.privacy.loadFailed"
                  : "settings.models.privacy.undeclared",
              )}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <PrivacySelect
              label={t("settings.models.privacy.executionLocation")}
              value={draft.executionLocation}
              placeholder={t("settings.models.privacy.selectExecutionLocation")}
              disabled={loadFailed || saving}
              onChange={(value) =>
                update(
                  "executionLocation",
                  value as Draft["executionLocation"],
                )
              }
              options={VERA_MODEL_EXECUTION_LOCATIONS.map((value) => ({
                value,
                label: t(`settings.models.privacy.executionLocations.${value}`),
              }))}
            />
            <PrivacySelect
              label={t("settings.models.privacy.retention")}
              value={draft.retention}
              placeholder={t("settings.models.privacy.selectRetention")}
              disabled={loadFailed || saving}
              onChange={(value) => update("retention", value as Draft["retention"])}
              options={VERA_MODEL_RETENTION_VALUES.map((value) => ({
                value,
                label: t(`settings.models.privacy.retentionValues.${value}`),
              }))}
            />
            <PrivacySelect
              label={t("settings.models.privacy.trainingUse")}
              value={draft.trainingUse}
              placeholder={t("settings.models.privacy.selectTrainingUse")}
              disabled={loadFailed || saving}
              onChange={(value) =>
                update("trainingUse", value as Draft["trainingUse"])
              }
              options={VERA_MODEL_TRAINING_USE_VALUES.map((value) => ({
                value,
                label: t(`settings.models.privacy.trainingUseValues.${value}`),
              }))}
            />
            <PrivacySelect
              label={t("settings.models.privacy.sensitiveData")}
              value={
                draft.sensitiveDataAllowed === null
                  ? ""
                  : draft.sensitiveDataAllowed
                    ? "allowed"
                    : "denied"
              }
              placeholder={t("settings.models.privacy.selectSensitiveData")}
              disabled={loadFailed || saving}
              onChange={(value) =>
                update("sensitiveDataAllowed", value === "allowed")
              }
              options={[
                {
                  value: "allowed",
                  label: t("settings.models.privacy.sensitiveDataAllowed"),
                },
                {
                  value: "denied",
                  label: t("settings.models.privacy.sensitiveDataDenied"),
                },
              ]}
            />
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("settings.models.privacy.localhostWarning")}
          </p>
          {unknownDenies && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              {t("settings.models.privacy.unknownWarning")}
            </p>
          )}
          {declaration && (
            <p className="text-xs text-gray-400">
              {t("settings.models.privacy.declarationBasis")} · {t(
                declaration.model_profile_enabled
                  ? "settings.models.privacy.enabledSnapshot"
                  : "settings.models.privacy.disabledSnapshot",
              )} · {formatDate(declaration.updated_at, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
          )}
          {!input && !loadFailed && (
            <p className="text-xs text-gray-400">
              {t("settings.models.privacy.completeRequired")}
            </p>
          )}
          {failure && <p role="alert" className="text-xs text-red-600">{failure}</p>}
          {saved && <p className="text-xs text-emerald-700">{t("settings.models.privacy.saved")}</p>}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!input || !changed || loadFailed || saving}
              onClick={() => void save()}
              className={`${accountGlassButtonClassName} inline-flex items-center gap-1.5`}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("settings.models.privacy.save")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PrivacySelect({
  label,
  value,
  placeholder,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1.5 text-xs text-gray-600 dark:text-gray-300">
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400 disabled:opacity-50 dark:border-white/10 dark:bg-gray-950 dark:text-gray-100"
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
