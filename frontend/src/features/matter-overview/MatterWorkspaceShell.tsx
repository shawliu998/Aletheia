"use client";

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import Link from "next/link";
import { AlertCircle, Loader2 } from "lucide-react";
import { ProjectWorkspaceProvider } from "@/app/components/projects/ProjectWorkspace";
import {
  MATTER_WORKSPACE_ROUTES,
  WorkspaceRouteProvider,
} from "@/app/components/projects/WorkspaceRouteAdapter";
import { UnavailableProjectSection } from "@/app/components/projects/ProjectPageParts";
import { useI18n } from "@/app/i18n";
import {
  getVeraMatter,
  type VeraMatterCapabilitiesWire,
  type VeraMatterWire,
} from "@/app/lib/veraMatterApi";
import {
  MatterNavigation,
  matterCapabilityReasonKey,
  matterCapabilityTitleKey,
} from "./MatterNavigation";

type MatterWorkspaceValue = {
  matter: VeraMatterWire;
  setMatter: (matter: VeraMatterWire) => void;
  reloadMatter: () => Promise<void>;
};

const MatterWorkspaceContext = createContext<MatterWorkspaceValue | null>(null);

export function useMatterWorkspace(): MatterWorkspaceValue {
  const value = useContext(MatterWorkspaceContext);
  if (!value) {
    throw new Error("useMatterWorkspace must be used inside MatterWorkspaceShell");
  }
  return value;
}

export function MatterWorkspaceShell({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: ReactNode;
}) {
  const { id } = use(params);
  const { errorMessage, t } = useI18n();
  const [matter, setMatter] = useState<VeraMatterWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setFailure(null);
    try {
      const loaded = await getVeraMatter(id, signal);
      if (!signal?.aborted) setMatter(loaded);
    } catch (cause) {
      if (!signal?.aborted) {
        setMatter(null);
        setFailure(errorMessage(cause as Error));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [errorMessage, id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("matters.detail.loading")}
      </div>
    );
  }

  if (!matter) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-white/70 bg-white/70 p-6 text-center shadow-lg backdrop-blur-xl">
          <AlertCircle className="mx-auto h-7 w-7 text-red-500" />
          <h1 className="mt-3 font-serif text-xl text-gray-900">
            {t("matters.detail.unavailable")}
          </h1>
          {failure && <p role="alert" className="mt-2 text-sm text-red-600">{failure}</p>}
          <div className="mt-5 flex justify-center gap-3">
            <button type="button" onClick={() => void load()} className="rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white">
              {t("common.actions.retry")}
            </button>
            <Link href="/matters" className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-medium text-gray-700">
              {t("matters.detail.back")}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <WorkspaceRouteProvider adapter={MATTER_WORKSPACE_ROUTES}>
      <MatterWorkspaceContext.Provider
        value={{
          matter,
          setMatter,
          reloadMatter: () => load(),
        }}
      >
        <ProjectWorkspaceProvider projectId={id}>
          <MatterNavigation projectId={id} capabilities={matter.capabilities} />
          {children}
        </ProjectWorkspaceProvider>
      </MatterWorkspaceContext.Provider>
    </WorkspaceRouteProvider>
  );
}

type GuardedCapability =
  | "matter_profile"
  | "assistant"
  | "workflows"
  | "tabular"
  | "drafts";

function capabilityAvailable(
  capabilities: VeraMatterCapabilitiesWire,
  capability: GuardedCapability,
): boolean {
  if (capability === "matter_profile") {
    return capabilities.matter_profile !== "unavailable";
  }
  if (capability === "assistant") return capabilities.assistant === "available";
  if (capability === "tabular") return capabilities.tabular === "available";
  if (capability === "workflows") {
    return (
      capabilities.workflows === "available" ||
      capabilities.workflows === "non_inference_only"
    );
  }
  return (
    capabilities.drafts === "document_scoped" ||
    capabilities.drafts === "available"
  );
}

export function MatterCapabilityBoundary({
  capability,
  children,
}: {
  capability: GuardedCapability;
  children: ReactNode;
}) {
  const { matter } = useMatterWorkspace();
  const { t } = useI18n();
  if (capabilityAvailable(matter.capabilities, capability)) return children;
  const value = matter.capabilities[capability];
  const inferenceCapability =
    capability === "assistant" || capability === "workflows" || capability === "tabular";
  const title = inferenceCapability
    ? t(matterCapabilityTitleKey(value as VeraMatterCapabilitiesWire["workflows"]))
    : t("matters.capabilities.readOnlyTitle");
  const subtitle = inferenceCapability
    ? t(matterCapabilityReasonKey(value as VeraMatterCapabilitiesWire["workflows"]))
    : t("matters.capabilities.readOnly");
  return (
    <UnavailableProjectSection
      title={title}
      subtitle={subtitle}
    />
  );
}
