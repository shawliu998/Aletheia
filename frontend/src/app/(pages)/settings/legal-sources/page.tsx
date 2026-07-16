"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  KeyRound,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Scale,
  ShieldCheck,
  Unplug,
  Wifi,
} from "lucide-react";
import {
  useI18n,
  type BackendErrorDescriptor,
  type MessageKey,
} from "@/app/i18n";
import { ConfirmPopup } from "@/app/components/shared/ConfirmPopup";
import {
  submitVeraCredentialInput,
  VeraCredentialInputError,
} from "@/app/components/models/modelCredentialSubmission";
import { VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS } from "@/app/lib/veraCredentialLimits";
import {
  VeraLegalSourceApiError,
  createVeraLegalSourceProvider,
  disableVeraLegalSourceProvider,
  enableVeraLegalSourceProvider,
  listVeraLegalSourceProviders,
  removeVeraLegalSourceSecret,
  saveVeraLegalSourceSecret,
  testVeraLegalSourceProvider,
  type VeraLegalSourceCapabilityName,
  type VeraLegalSourceProvider,
  type VeraLegalSourceStatus,
} from "@/app/lib/veraLegalSourceApi";
import { AccountSection } from "../AccountSection";
import {
  accountGlassButtonClassName,
  accountGlassDangerButtonClassName,
  accountGlassInputClassName,
  accountGlassPrimaryButtonClassName,
} from "../accountStyles";

type LoadState = "loading" | "ready" | "error";
type OperationKind =
  "create" | "save" | "remove" | "test" | "enable" | "disable";
type Operation = { id: string; kind: OperationKind };
type Feedback = { id: string; kind: OperationKind };
type ProviderFailure = { id: string; error: BackendErrorDescriptor };

const STATUS_KEYS = {
  unavailable: "settings.legalSources.status.unavailable",
  not_configured: "settings.legalSources.status.notConfigured",
  configured_unverified: "settings.legalSources.status.configuredUnverified",
  ready: "settings.legalSources.status.ready",
  authentication_failed: "settings.legalSources.status.authenticationFailed",
  license_restricted: "settings.legalSources.status.licenseRestricted",
  activation_gate_closed: "settings.legalSources.status.activationGateClosed",
  temporarily_unavailable:
    "settings.legalSources.status.temporarilyUnavailable",
} as const satisfies Record<VeraLegalSourceStatus, MessageKey>;

const CAPABILITY_KEYS = {
  law: "settings.legalSources.capabilities.names.law",
  case: "settings.legalSources.capabilities.names.case",
  company: "settings.legalSources.capabilities.names.company",
} as const satisfies Record<VeraLegalSourceCapabilityName, MessageKey>;

const FEEDBACK_KEYS = {
  create: "settings.legalSources.feedback.created",
  save: "settings.legalSources.credential.saved",
  remove: "settings.legalSources.credential.removed",
  test: "settings.legalSources.feedback.testComplete",
  enable: "settings.legalSources.feedback.enabled",
  disable: "settings.legalSources.feedback.disabled",
} as const satisfies Record<OperationKind, MessageKey>;

function safeFailure(error: unknown): BackendErrorDescriptor {
  if (error instanceof VeraLegalSourceApiError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof VeraCredentialInputError) {
    return { code: "VALIDATION_ERROR" };
  }
  return { code: "NETWORK_ERROR" };
}

export default function LegalSourceSettingsPage() {
  const { t, errorMessage } = useI18n();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [profiles, setProfiles] = useState<readonly VeraLegalSourceProvider[]>(
    [],
  );
  const [loadFailure, setLoadFailure] = useState<BackendErrorDescriptor | null>(
    null,
  );
  const [providerFailure, setProviderFailure] =
    useState<ProviderFailure | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const hasLoaded = useRef(false);

  const loadProfiles = useCallback(
    async (showLoading: boolean): Promise<void> => {
      const sequence = ++requestSequence.current;
      if (showLoading) setLoadState("loading");
      setRefreshing(true);
      setLoadFailure(null);
      try {
        const result = await listVeraLegalSourceProviders();
        if (!mounted.current || sequence !== requestSequence.current) return;
        hasLoaded.current = true;
        setProfiles(result.providers);
        setLoadState("ready");
      } catch (error) {
        if (!mounted.current || sequence !== requestSequence.current) return;
        setLoadFailure(safeFailure(error));
        if (!hasLoaded.current) setLoadState("error");
      } finally {
        if (mounted.current && sequence === requestSequence.current) {
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    mounted.current = true;
    void loadProfiles(true);
    return () => {
      mounted.current = false;
      requestSequence.current += 1;
    };
  }, [loadProfiles]);

  function applyProfile(profile: VeraLegalSourceProvider) {
    setProfiles((current) => {
      const existing = current.some(({ id }) => id === profile.id);
      return existing
        ? current.map((item) => (item.id === profile.id ? profile : item))
        : [profile];
    });
  }

  async function createProfile() {
    if (operation || refreshing || profiles.length !== 0) return;
    setOperation({ id: "new", kind: "create" });
    setProviderFailure(null);
    setFeedback(null);
    try {
      const profile = await createVeraLegalSourceProvider();
      if (!mounted.current) return;
      applyProfile(profile);
      setFeedback({ id: profile.id, kind: "create" });
    } catch (error) {
      if (mounted.current) setLoadFailure(safeFailure(error));
    } finally {
      if (mounted.current) setOperation(null);
    }
  }

  async function saveCredential(
    profile: VeraLegalSourceProvider,
    field: Pick<HTMLInputElement, "value">,
  ) {
    if (operation || refreshing) return;
    setOperation({ id: profile.id, kind: "save" });
    setProviderFailure(null);
    setFeedback(null);
    try {
      await submitVeraCredentialInput(
        field,
        async (secret) => {
          const updated = await saveVeraLegalSourceSecret(
            profile.id,
            profile.revision,
            secret,
          );
          if (mounted.current) applyProfile(updated);
        },
        { maxCharacters: VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS },
      );
      if (!mounted.current) return;
      setFeedback({ id: profile.id, kind: "save" });
    } catch (error) {
      if (mounted.current) {
        setProviderFailure({ id: profile.id, error: safeFailure(error) });
      }
    } finally {
      field.value = "";
      if (mounted.current) setOperation(null);
    }
  }

  async function mutate(
    profile: VeraLegalSourceProvider,
    kind: Exclude<OperationKind, "create" | "save">,
  ) {
    if (operation || refreshing) return;
    setOperation({ id: profile.id, kind });
    setProviderFailure(null);
    setFeedback(null);
    try {
      const updated = await (kind === "remove"
        ? removeVeraLegalSourceSecret(profile.id, profile.revision)
        : kind === "test"
          ? testVeraLegalSourceProvider(profile.id, profile.revision)
          : kind === "enable"
            ? enableVeraLegalSourceProvider(profile.id, profile.revision)
            : disableVeraLegalSourceProvider(profile.id, profile.revision));
      if (!mounted.current) return;
      applyProfile(updated);
      if (kind === "remove") setRemoveTargetId(null);
      setFeedback({ id: profile.id, kind });
    } catch (error) {
      if (mounted.current) {
        setProviderFailure({ id: profile.id, error: safeFailure(error) });
      }
    } finally {
      if (mounted.current) setOperation(null);
    }
  }

  const removeTarget = profiles.find(({ id }) => id === removeTargetId);

  if (loadState === "loading") {
    return (
      <PageState
        icon={<Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />}
        title={t("common.status.loading")}
        body={t("settings.legalSources.loading")}
      />
    );
  }

  if (loadState === "error") {
    return (
      <PageState
        role="alert"
        icon={
          <AlertCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
        }
        title={t("settings.legalSources.errors.loadTitle")}
        body={errorMessage(loadFailure)}
        action={
          <button
            type="button"
            onClick={() => void loadProfiles(true)}
            className={accountGlassButtonClassName}
          >
            {t("common.actions.retry")}
          </button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-serif text-2xl font-medium text-gray-900 dark:text-gray-100">
            {t("settings.legalSources.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            {t("settings.legalSources.description")}
          </p>
        </div>
        <button
          type="button"
          disabled={refreshing || operation !== null}
          aria-busy={refreshing}
          onClick={() => void loadProfiles(false)}
          className={`${accountGlassButtonClassName} inline-flex h-9 items-center gap-1.5`}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {t("common.actions.refresh")}
        </button>
      </div>

      <AccountSection className="p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("settings.legalSources.localStatus.title")}
            </p>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
              {t("settings.legalSources.localStatus.body")}
            </p>
          </div>
        </div>
      </AccountSection>

      {loadFailure && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
        >
          {errorMessage(loadFailure)}
        </p>
      )}

      {profiles.length === 0 ? (
        <AccountSection className="p-6 text-center">
          <Scale className="mx-auto h-5 w-5 text-gray-400" aria-hidden="true" />
          <h3 className="mt-3 text-base font-medium text-gray-900 dark:text-gray-100">
            {t("settings.legalSources.empty.title")}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
            {t("settings.legalSources.empty.body")}
          </p>
          <button
            type="button"
            disabled={operation !== null || refreshing}
            onClick={() => void createProfile()}
            className={`${accountGlassPrimaryButtonClassName} mt-4 inline-flex items-center gap-1.5`}
          >
            {operation?.kind === "create" && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            )}
            {t("settings.legalSources.empty.action")}
          </button>
        </AccountSection>
      ) : (
        profiles.map((profile) => (
          <ProviderCard
            key={profile.id}
            profile={profile}
            operation={operation}
            refreshing={refreshing}
            failure={
              providerFailure?.id === profile.id ? providerFailure.error : null
            }
            feedback={feedback?.id === profile.id ? feedback.kind : null}
            onSave={(field) => void saveCredential(profile, field)}
            onRemove={() => setRemoveTargetId(profile.id)}
            onTest={() => void mutate(profile, "test")}
            onEnable={() => void mutate(profile, "enable")}
            onDisable={() => void mutate(profile, "disable")}
          />
        ))
      )}

      <ConfirmPopup
        open={Boolean(removeTarget)}
        title={t("settings.legalSources.credential.removeConfirmTitle")}
        message={
          removeTarget
            ? t("settings.legalSources.credential.removeConfirmBody", {
                provider: t("settings.legalSources.providers.yuandian"),
              })
            : undefined
        }
        confirmLabel={t("settings.legalSources.credential.remove")}
        confirmStatus={operation?.kind === "remove" ? "loading" : "idle"}
        confirmDisabled={
          !removeTarget?.credential_configured ||
          operation !== null ||
          refreshing
        }
        cancelDisabled={operation?.kind === "remove"}
        onCancel={() => {
          if (!operation) setRemoveTargetId(null);
        }}
        onConfirm={() => {
          if (removeTarget) void mutate(removeTarget, "remove");
        }}
      />
    </div>
  );
}

function ProviderCard({
  profile,
  operation,
  refreshing,
  failure,
  feedback,
  onSave,
  onRemove,
  onTest,
  onEnable,
  onDisable,
}: {
  profile: VeraLegalSourceProvider;
  operation: Operation | null;
  refreshing: boolean;
  failure: BackendErrorDescriptor | null;
  feedback: OperationKind | null;
  onSave: (field: Pick<HTMLInputElement, "value">) => void;
  onRemove: () => void;
  onTest: () => void;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = refreshing || operation !== null;
  const currentOperation = operation?.id === profile.id ? operation.kind : null;
  const inputId = `vera-legal-provider-${profile.id}-credential`;
  const testPassed = profile.connection_test?.status === "passed";
  const enableDisabled = busy || !profile.credential_configured || !testPassed;

  useEffect(() => {
    if (busy && inputRef.current) inputRef.current.value = "";
  }, [busy]);
  useEffect(
    () => () => {
      if (inputRef.current) inputRef.current.value = "";
    },
    [],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !inputRef.current) return;
    onSave(inputRef.current);
  }

  return (
    <AccountSection data-testid="legal-source-provider-yuandian">
      <div className="px-4 py-5 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="rounded-lg bg-gray-100 p-2 text-gray-600 dark:bg-white/10 dark:text-gray-300">
              <Scale className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
                {t("settings.legalSources.providers.yuandian")}
              </h3>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t("settings.legalSources.providerContract")} ·{" "}
                {profile.endpoint_set_id}
              </p>
            </div>
          </div>
          <StatusBadge status={profile.status} />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {profile.capabilities.map(({ capability, enabled }) => (
            <div
              key={capability}
              className="rounded-lg border border-black/5 px-3 py-2 dark:border-white/10"
            >
              <p className="text-xs font-medium text-gray-700 dark:text-gray-200">
                {t(CAPABILITY_KEYS[capability])}
              </p>
              <p
                className={`mt-1 text-xs ${enabled ? "text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400"}`}
              >
                {t(
                  enabled
                    ? "settings.legalSources.capabilities.enabled"
                    : "settings.legalSources.capabilities.disabled",
                )}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900 dark:bg-amber-950/20">
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t("settings.legalSources.policy.title")}
          </h4>
          <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">
            {t("settings.legalSources.policy.description")}
          </p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t("settings.legalSources.policy.retention")}
              </dt>
              <dd className="mt-1 text-xs font-medium text-gray-900 dark:text-gray-100">
                {t("settings.legalSources.policy.values.notDeclared")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t("settings.legalSources.policy.localProcessing")}
              </dt>
              <dd className="mt-1 text-xs font-medium text-gray-900 dark:text-gray-100">
                {profile.usage_policy.local_processing === "transient_only"
                  ? t("settings.legalSources.policy.values.transientOnly")
                  : t("settings.legalSources.policy.values.notDeclared")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t("settings.legalSources.policy.modelUse")}
              </dt>
              <dd className="mt-1 text-xs font-medium text-gray-900 dark:text-gray-100">
                {profile.usage_policy.model_use ===
                "prohibited_pending_authorization"
                  ? t("settings.legalSources.policy.values.prohibited")
                  : t("settings.legalSources.policy.values.notDeclared")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">
                {t("settings.legalSources.policy.export")}
              </dt>
              <dd className="mt-1 text-xs font-medium text-gray-900 dark:text-gray-100">
                {profile.usage_policy.export ===
                "prohibited_pending_authorization"
                  ? t("settings.legalSources.policy.values.prohibited")
                  : t("settings.legalSources.policy.values.notDeclared")}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-300">
            {t("settings.legalSources.policy.notDeclaredWarning")}
          </p>
        </div>
      </div>

      <Divider />

      <div className="px-4 py-5 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("settings.legalSources.connection.title")}
            </h4>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {profile.connection_test === null
                ? t("settings.legalSources.connection.untested")
                : profile.connection_test.status === "passed"
                  ? t("settings.legalSources.connection.passed")
                  : t("settings.legalSources.connection.failed")}
            </p>
          </div>
          <button
            type="button"
            disabled={busy || !profile.credential_configured}
            onClick={onTest}
            className={`${accountGlassButtonClassName} inline-flex h-9 items-center gap-1.5`}
          >
            {currentOperation === "test" ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t("settings.legalSources.connection.test")}
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-black/5 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/10">
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              {t(
                profile.enabled
                  ? "settings.legalSources.activation.enabled"
                  : "settings.legalSources.activation.disabled",
              )}
            </p>
            {profile.status === "activation_gate_closed" && (
              <p className="mt-1 max-w-xl text-xs leading-5 text-amber-700 dark:text-amber-300">
                {t("settings.legalSources.activation.gateClosed")}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={profile.enabled ? busy : enableDisabled}
            onClick={profile.enabled ? onDisable : onEnable}
            className={`${profile.enabled ? accountGlassDangerButtonClassName : accountGlassPrimaryButtonClassName} inline-flex h-9 items-center gap-1.5`}
          >
            {currentOperation === "enable" || currentOperation === "disable" ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : profile.enabled ? (
              <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t(
              profile.enabled
                ? "settings.legalSources.activation.disable"
                : "settings.legalSources.activation.enable",
            )}
          </button>
        </div>
      </div>

      <Divider />

      <div className="px-4 py-5 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t("settings.legalSources.credential.title")}
            </h4>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                profile.credential_configured
                  ? "settings.legalSources.credential.configured"
                  : "settings.legalSources.credential.missing",
              )}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
            {t("settings.legalSources.credential.localOnly")}
          </span>
        </div>

        <form
          onSubmit={submit}
          className="mt-4 space-y-3"
          aria-label={t("settings.legalSources.credential.formLabel", {
            provider: t("settings.legalSources.providers.yuandian"),
          })}
        >
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-200"
          >
            {t("settings.legalSources.credential.inputLabel")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <KeyRound
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                id={inputId}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS}
                disabled={busy}
                className={`${accountGlassInputClassName} h-9 w-full pl-9 text-sm`}
                placeholder={t("settings.legalSources.credential.placeholder")}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className={`${accountGlassPrimaryButtonClassName} inline-flex h-9 items-center gap-1.5`}
            >
              {currentOperation === "save" && (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              {t(
                profile.credential_configured
                  ? "settings.legalSources.credential.replace"
                  : "settings.legalSources.credential.store",
              )}
            </button>
            <button
              type="button"
              disabled={busy || !profile.credential_configured}
              onClick={onRemove}
              className={`${accountGlassDangerButtonClassName} h-9`}
            >
              {t("settings.legalSources.credential.remove")}
            </button>
          </div>
          <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">
            {t("settings.legalSources.credential.description")}
          </p>
        </form>

        {failure && (
          <p
            role="alert"
            className="mt-3 text-xs text-red-600 dark:text-red-400"
          >
            {errorMessage(failure)}
          </p>
        )}
        {feedback && (
          <p
            role="status"
            className="mt-3 text-xs text-emerald-700 dark:text-emerald-400"
          >
            {t(FEEDBACK_KEYS[feedback])}
          </p>
        )}
      </div>
    </AccountSection>
  );
}

function StatusBadge({ status }: { status: VeraLegalSourceStatus }) {
  const { t } = useI18n();
  const ready = status === "ready";
  const caution =
    status === "configured_unverified" || status === "activation_gate_closed";
  return (
    <span
      className={`inline-flex w-fit rounded-full px-2.5 py-1 text-xs font-medium ${ready ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : caution ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" : "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"}`}
    >
      {t(STATUS_KEYS[status])}
    </span>
  );
}

function Divider() {
  return <div className="h-px bg-black/5 dark:bg-white/10" />;
}

function PageState({
  icon,
  title,
  body,
  action,
  role,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
  role?: "alert";
}) {
  return (
    <AccountSection className="p-8 text-center" role={role}>
      <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-300">
        {icon}
      </span>
      <h2 className="mt-3 text-base font-medium text-gray-900 dark:text-gray-100">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
        {body}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </AccountSection>
  );
}
