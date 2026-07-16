"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "@/app/i18n";
import type { VeraMatterCapabilitiesWire } from "@/app/lib/veraMatterApi";

type MatterInferenceCapabilityValue =
  | VeraMatterCapabilitiesWire["assistant"]
  | VeraMatterCapabilitiesWire["workflows"]
  | VeraMatterCapabilitiesWire["tabular"];

export function matterCapabilityTitleKey(value: MatterInferenceCapabilityValue) {
  if (value === "available") return "matters.capabilities.availableTitle" as const;
  if (value === "non_inference_only") return "matters.capabilities.nonInferenceOnlyTitle" as const;
  if (value === "require_approval") return "matters.capabilities.approvalRequiredTitle" as const;
  if (value === "policy_gate_closed") return "matters.capabilities.inferenceClosedTitle" as const;
  return "matters.capabilities.unavailableTitle" as const;
}

export function matterCapabilityReasonKey(value: MatterInferenceCapabilityValue) {
  if (value === "available") return "matters.capabilities.available" as const;
  if (value === "non_inference_only") return "matters.capabilities.nonInferenceOnly" as const;
  if (value === "require_approval") return "matters.capabilities.approvalRequired" as const;
  if (value === "policy_gate_closed") return "matters.capabilities.inferenceClosed" as const;
  return "matters.capabilities.unavailable" as const;
}

type MatterNavigationItem = {
  href: string;
  label: string;
  enabled: boolean;
  disabledReason: string;
};

export function MatterNavigation({
  projectId,
  capabilities,
}: {
  projectId: string;
  capabilities: VeraMatterCapabilitiesWire;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const base = `/matters/${projectId}`;
  const unavailable = t("common.status.unavailable");
  const items: MatterNavigationItem[] = [
    {
      href: base,
      label: t("matters.navigation.overview"),
      enabled: true,
      disabledReason: "",
    },
    {
      href: `${base}/documents`,
      label: t("matters.navigation.documents"),
      enabled: true,
      disabledReason: "",
    },
    {
      href: `${base}/assistant`,
      label: t("matters.navigation.assistant"),
      enabled: capabilities.assistant === "available",
      disabledReason: t(matterCapabilityReasonKey(capabilities.assistant)),
    },
    {
      href: `${base}/review`,
      label: t("matters.navigation.review"),
      enabled: capabilities.tabular === "available",
      disabledReason: t(matterCapabilityReasonKey(capabilities.tabular)),
    },
    {
      href: `${base}/workflows`,
      label: t("matters.navigation.workflows"),
      enabled:
        capabilities.workflows === "available" ||
        capabilities.workflows === "non_inference_only",
      disabledReason: t(matterCapabilityReasonKey(capabilities.workflows)),
    },
    {
      href: `${base}/drafts`,
      label: t("matters.navigation.drafts"),
      enabled:
        capabilities.drafts === "document_scoped" ||
        capabilities.drafts === "available",
      disabledReason: t("matters.capabilities.draftsDocumentScoped"),
    },
    {
      href: `${base}/settings`,
      label: t("matters.navigation.settings"),
      enabled: capabilities.matter_profile !== "unavailable",
      disabledReason: t("matters.capabilities.readOnly"),
    },
  ];

  const inferenceStatuses = [
    {
      label: t("matters.navigation.assistant"),
      value: capabilities.assistant,
    },
    {
      label: t("matters.capabilities.tabularCompatibilityLabel"),
      value: capabilities.tabular,
    },
    {
      label: t("matters.navigation.workflows"),
      value: capabilities.workflows,
    },
  ] as const;

  return (
    <>
      <nav
      aria-label={t("matters.navigation.label")}
      className="flex h-10 shrink-0 items-center gap-5 overflow-x-auto border-b border-gray-200 px-4 md:px-10"
      >
        {items.map((item) => {
        const active =
          item.href === base
            ? pathname === base
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        if (!item.enabled) {
          return (
            <button
              key={item.href}
              type="button"
              disabled
              aria-disabled="true"
              title={item.disabledReason}
              className="inline-flex shrink-0 cursor-not-allowed items-center gap-1.5 text-xs text-gray-300"
            >
              {item.label}
              <span className="text-[10px] font-normal">{unavailable}</span>
            </button>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${
              active
                ? "font-medium text-gray-800"
                : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {item.label}
          </Link>
        );
        })}
      </nav>
      <div
        aria-label={t("matters.capabilities.inferenceStatus")}
        className="flex min-h-8 shrink-0 items-center gap-x-5 gap-y-1 overflow-x-auto border-b border-gray-100 bg-gray-50/70 px-4 py-1 text-[10px] text-gray-500 md:px-10"
      >
        {inferenceStatuses.map((status) => (
          <span key={status.label} className="shrink-0" title={t(matterCapabilityReasonKey(status.value))}>
            {status.label}: <strong className="font-medium text-gray-700">{t(matterCapabilityTitleKey(status.value))}</strong>
          </span>
        ))}
      </div>
    </>
  );
}
