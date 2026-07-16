"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { VeraApiError } from "@/app/lib/veraApi";
import {
  getVeraMatterPolicy,
  updateVeraMatter,
  updateVeraMatterPolicy,
  VERA_EXECUTION_LOCATIONS,
  type VeraExecutionLocation,
  type VeraMatterPolicyUpdateWire,
  type VeraMatterPolicyWire,
  type VeraMatterUpdateWire,
} from "@/app/lib/veraMatterApi";
import { useMatterWorkspace } from "./MatterWorkspaceShell";

type MatterFormState = {
  name: string;
  description: string;
  cmNumber: string;
  practice: string;
  workspaceType: string;
  clientName: string;
  jurisdiction: string;
  representedRole: string;
  objective: string;
};

function formFromMatter(
  matter: ReturnType<typeof useMatterWorkspace>["matter"],
): MatterFormState {
  return {
    name: matter.project.name,
    description: matter.project.description ?? "",
    cmNumber: matter.project.cm_number ?? "",
    practice: matter.project.practice ?? "",
    workspaceType: matter.matter_profile?.workspace_type ?? "",
    clientName: matter.matter_profile?.client_name ?? "",
    jurisdiction: matter.matter_profile?.jurisdiction ?? "",
    representedRole: matter.matter_profile?.represented_role ?? "",
    objective: matter.matter_profile?.objective ?? "",
  };
}

function normalizedOptional(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function matterUpdate(
  matter: ReturnType<typeof useMatterWorkspace>["matter"],
  form: MatterFormState,
): VeraMatterUpdateWire | null {
  const project: NonNullable<VeraMatterUpdateWire["project"]> = {};
  const profile: NonNullable<VeraMatterUpdateWire["profile"]> = {};
  const name = form.name.trim();
  if (name !== matter.project.name) project.name = name;
  for (const [formKey, wireKey, current] of [
    ["description", "description", matter.project.description],
    ["cmNumber", "cm_number", matter.project.cm_number],
    ["practice", "practice", matter.project.practice],
  ] as const) {
    const next = normalizedOptional(form[formKey]);
    if (next !== (current || null)) project[wireKey] = next;
  }
  const currentProfile = matter.matter_profile;
  if (currentProfile) {
    if (
      form.workspaceType &&
      form.workspaceType !== currentProfile.workspace_type
    ) {
      profile.workspace_type = form.workspaceType as NonNullable<
        typeof profile.workspace_type
      >;
    }
    for (const [formKey, wireKey, current] of [
      ["clientName", "client_name", currentProfile.client_name],
      ["jurisdiction", "jurisdiction", currentProfile.jurisdiction],
      ["representedRole", "represented_role", currentProfile.represented_role],
      ["objective", "objective", currentProfile.objective],
    ] as const) {
      const next = normalizedOptional(form[formKey]);
      if (next !== (current || null)) profile[wireKey] = next;
    }
  }
  return Object.keys(project).length === 0 && Object.keys(profile).length === 0
    ? null
    : {
        ...(Object.keys(project).length > 0 ? { project } : {}),
        ...(Object.keys(profile).length > 0 ? { profile } : {}),
      };
}

function policyInput(policy: VeraMatterPolicyWire): VeraMatterPolicyUpdateWire {
  return {
    external_egress_mode: policy.external_egress_mode,
    execution_locations: [...policy.execution_locations],
    allow_external_legal_sources: policy.allow_external_legal_sources,
    allow_word_bridge: policy.allow_word_bridge,
  };
}

const MISSING_POLICY_DRAFT: VeraMatterPolicyUpdateWire = {
  external_egress_mode: "disabled",
  execution_locations: [],
  allow_external_legal_sources: false,
  allow_word_bridge: false,
};

export function MatterSettings() {
  const { matter, setMatter } = useMatterWorkspace();
  const { t, errorMessage } = useI18n();
  const [form, setForm] = useState(() => formFromMatter(matter));
  const [matterBusy, setMatterBusy] = useState(false);
  const [matterFailure, setMatterFailure] = useState<string | null>(null);
  const [matterSaved, setMatterSaved] = useState(false);
  const [policy, setPolicy] = useState<VeraMatterPolicyWire | null>(null);
  const [policyDraft, setPolicyDraft] = useState<VeraMatterPolicyUpdateWire | null>(null);
  const [policyMissing, setPolicyMissing] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyFailure, setPolicyFailure] = useState<string | null>(null);
  const [policySaved, setPolicySaved] = useState(false);

  useEffect(() => setForm(formFromMatter(matter)), [matter]);

  useEffect(() => {
    if (!matter.matter_profile) {
      setPolicyLoading(false);
      setPolicy(null);
      setPolicyDraft(null);
      setPolicyMissing(false);
      return;
    }
    const controller = new AbortController();
    setPolicyLoading(true);
    setPolicyFailure(null);
    setPolicyMissing(false);
    getVeraMatterPolicy(matter.project.id, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setPolicy(loaded);
        setPolicyDraft(policyInput(loaded));
        setPolicyMissing(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setPolicy(null);
        if (cause instanceof VeraApiError && cause.status === 404) {
          setPolicyDraft({ ...MISSING_POLICY_DRAFT });
          setPolicyMissing(true);
          setPolicyFailure(null);
        } else {
          setPolicyDraft(null);
          setPolicyMissing(false);
          setPolicyFailure(errorMessage(cause as Error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPolicyLoading(false);
      });
    return () => controller.abort();
  }, [errorMessage, matter.matter_profile, matter.project.id]);

  const update = (key: keyof MatterFormState, value: string) => {
    setMatterSaved(false);
    setMatterFailure(null);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const pendingMatterUpdate = useMemo(
    () => matterUpdate(matter, form),
    [form, matter],
  );
  const profileClassificationMissing =
    matter.matter_profile !== null && form.workspaceType.length === 0;

  const saveMatter = async () => {
    if (
      !pendingMatterUpdate ||
      !form.name.trim() ||
      profileClassificationMissing ||
      matterBusy
    ) {
      if (profileClassificationMissing) {
        setMatterFailure(t("matters.settings.profileRequired"));
      }
      return;
    }
    setMatterBusy(true);
    setMatterSaved(false);
    setMatterFailure(null);
    try {
      const saved = await updateVeraMatter(matter.project.id, pendingMatterUpdate);
      setMatter(saved);
      setMatterSaved(true);
    } catch {
      setMatterFailure(t("matters.settings.errors.matterSave"));
    } finally {
      setMatterBusy(false);
    }
  };

  const setPolicyValue = <K extends keyof VeraMatterPolicyUpdateWire>(
    key: K,
    value: VeraMatterPolicyUpdateWire[K],
  ) => {
    setPolicySaved(false);
    setPolicyFailure(null);
    setPolicyDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const toggleLocation = (location: VeraExecutionLocation) => {
    if (!policyDraft) return;
    const next = policyDraft.execution_locations.includes(location)
      ? policyDraft.execution_locations.filter((item) => item !== location)
      : VERA_EXECUTION_LOCATIONS.filter(
          (item) =>
            item === location || policyDraft.execution_locations.includes(item),
        );
    setPolicyValue("execution_locations", next);
  };

  const policyChanged = Boolean(
    policyDraft &&
      (policyMissing ||
        (policy &&
          JSON.stringify(policyInput(policy)) !== JSON.stringify(policyDraft))),
  );

  const savePolicy = async () => {
    if (!policyDraft || !policyChanged || policyBusy) return;
    setPolicyBusy(true);
    setPolicySaved(false);
    setPolicyFailure(null);
    try {
      const saved = await updateVeraMatterPolicy(matter.project.id, policyDraft);
      setPolicy(saved);
      setPolicyDraft(policyInput(saved));
      setPolicyMissing(false);
      setPolicySaved(true);
    } catch {
      setPolicyFailure(t("matters.settings.errors.policySave"));
    } finally {
      setPolicyBusy(false);
    }
  };

  if (!matter.matter_profile) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-2xl border border-white/70 bg-white/70 p-7 text-center shadow-lg backdrop-blur-xl">
          <AlertCircle className="mx-auto h-7 w-7 text-amber-500" />
          <p className="mt-3 text-sm text-gray-700">{t("matters.settings.profileRequired")}</p>
          <Link href={`/matters/${matter.project.id}`} className="mt-4 inline-flex rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white">
            {t("matters.navigation.overview")}
          </Link>
        </div>
      </main>
    );
  }

  if (matter.capabilities.matter_profile === "unavailable") {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-gray-600">
        {t("matters.capabilities.readOnly")}
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <h1 className="font-serif text-2xl text-gray-900">{t("matters.settings.title")}</h1>
          <p className="mt-1 text-sm text-gray-500">{t("matters.settings.subtitle")}</p>
        </header>

        <section aria-label={t("matters.settings.generalTitle")} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <SectionHeading title={t("matters.settings.generalTitle")} owner={t("matters.settings.generalOwner")} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label={t("matters.fields.name")} value={form.name} onChange={(value) => update("name", value)} required />
            <Field label={t("matters.fields.matterNumber")} value={form.cmNumber} onChange={(value) => update("cmNumber", value)} />
            <Field label={t("matters.fields.practiceArea")} value={form.practice} onChange={(value) => update("practice", value)} />
            <Field className="sm:col-span-2" label={t("matters.fields.description")} value={form.description} onChange={(value) => update("description", value)} multiline />
          </div>
        </section>

        <section aria-label={t("matters.settings.profileTitle")} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <SectionHeading title={t("matters.settings.profileTitle")} owner={t("matters.settings.profileOwner")} />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs text-gray-600">
              <span>{t("matters.fields.workspaceType")}</span>
              <select value={form.workspaceType} onChange={(event) => update("workspaceType", event.target.value)} className={CONTROL_CLASS}>
                <option value="">{t("matters.form.selectWorkspaceType")}</option>
                {(["general_legal", "transaction", "dispute", "investigation", "compliance", "research"] as const).map((value) => (
                  <option key={value} value={value}>{t(`matters.workspaceTypes.${value}`)}</option>
                ))}
              </select>
            </label>
            <Field label={t("matters.fields.clientName")} value={form.clientName} onChange={(value) => update("clientName", value)} />
            <Field label={t("matters.fields.jurisdiction")} value={form.jurisdiction} onChange={(value) => update("jurisdiction", value)} />
            <Field label={t("matters.fields.representedRole")} value={form.representedRole} onChange={(value) => update("representedRole", value)} />
            <Field className="sm:col-span-2" label={t("matters.fields.objective")} value={form.objective} onChange={(value) => update("objective", value)} multiline />
          </div>
          <SaveRow busy={matterBusy} disabled={!pendingMatterUpdate || !form.name.trim() || profileClassificationMissing} saved={matterSaved} failure={matterFailure} label={t("matters.settings.saveMatter")} unchanged={t("matters.settings.unchanged")} savedLabel={t("matters.settings.saved")} onSave={() => void saveMatter()} />
        </section>

        <section aria-label={t("matters.settings.policyTitle")} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <SectionHeading title={t("matters.settings.policyTitle")} owner={t("matters.settings.policyOwner")} />
          {policyLoading ? (
            <div className="mt-5 flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />{t("common.status.loading")}</div>
          ) : !policyDraft ? (
            <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700">{t("matters.settings.policyUnavailable")}</p>
          ) : (
            <div className="mt-5 space-y-5">
              {policyMissing && (
                <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
                  {t("matters.settings.policyMissing")}
                </p>
              )}
              <label className="block space-y-1.5 text-xs text-gray-600">
                <span>{t("matters.settings.externalEgressMode")}</span>
                <select value={policyDraft.external_egress_mode} onChange={(event) => setPolicyValue("external_egress_mode", event.target.value as VeraMatterPolicyUpdateWire["external_egress_mode"])} className={CONTROL_CLASS}>
                  {(["disabled", "approval", "allowed_by_policy"] as const).map((value) => <option key={value} value={value}>{t(`matters.settings.externalEgressModes.${value}`)}</option>)}
                </select>
              </label>
              {policyDraft.external_egress_mode === "approval" && <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">{t("matters.settings.approvalNotice")}</p>}
              <fieldset>
                <legend className="text-xs text-gray-600">{t("matters.settings.executionLocations")}</legend>
                <p className="mt-1 text-xs text-gray-400">{t("matters.settings.executionLocationsHint")}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {VERA_EXECUTION_LOCATIONS.map((location) => (
                    <label key={location} className="flex items-center gap-2 rounded-xl border border-gray-100 p-3 text-sm text-gray-700">
                      <input type="checkbox" checked={policyDraft.execution_locations.includes(location)} onChange={() => toggleLocation(location)} />
                      {t(`matters.settings.locations.${location}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <DeclarationToggle label={t("matters.settings.externalLegalSources")} checked={policyDraft.allow_external_legal_sources} onChange={(checked) => setPolicyValue("allow_external_legal_sources", checked)} />
              <DeclarationToggle label={t("matters.settings.wordBridge")} checked={policyDraft.allow_word_bridge} onChange={(checked) => setPolicyValue("allow_word_bridge", checked)} />
              <SaveRow busy={policyBusy} disabled={!policyChanged} saved={policySaved} failure={policyFailure} label={t("matters.settings.savePolicy")} unchanged={t("matters.settings.unchanged")} savedLabel={t("matters.settings.saved")} onSave={() => void savePolicy()} />
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div>
              <h2 className="text-sm font-semibold text-amber-950">{t("matters.settings.modelPrivacyTitle")}</h2>
              <p className="mt-1 text-sm text-amber-800">{t("matters.settings.modelPrivacyMissing")}</p>
              <Link href="/settings/models" className="mt-3 inline-flex text-xs font-medium text-amber-950 underline underline-offset-2">{t("matters.settings.openModelSettings")}</Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

const CONTROL_CLASS = "w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400";

function SectionHeading({ title, owner }: { title: string; owner: string }) {
  return <div><h2 className="text-sm font-semibold text-gray-900">{title}</h2><p className="mt-1 text-xs text-gray-500">{owner}</p></div>;
}

function Field({ label, value, onChange, required = false, multiline = false, className = "" }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; multiline?: boolean; className?: string }) {
  return <label className={`space-y-1.5 text-xs text-gray-600 ${className}`}><span>{label}</span>{multiline ? <textarea required={required} value={value} onChange={(event) => onChange(event.target.value)} rows={3} className={CONTROL_CLASS} /> : <input required={required} value={value} onChange={(event) => onChange(event.target.value)} className={CONTROL_CLASS} />}</label>;
}

function DeclarationToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-center justify-between gap-4 rounded-xl border border-gray-100 p-3 text-sm text-gray-700"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>;
}

function SaveRow({ busy, disabled, saved, failure, label, unchanged, savedLabel, onSave }: { busy: boolean; disabled: boolean; saved: boolean; failure: string | null; label: string; unchanged: string; savedLabel: string; onSave: () => void }) {
  return <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-gray-100 pt-4">{failure ? <p role="alert" className="mr-auto text-xs text-red-600">{failure}</p> : saved ? <p className="mr-auto text-xs text-green-700">{savedLabel}</p> : disabled ? <p className="mr-auto text-xs text-gray-400">{unchanged}</p> : null}<button type="button" disabled={disabled || busy} onClick={onSave} className="rounded-full bg-gray-950 px-4 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : label}</button></div>;
}
