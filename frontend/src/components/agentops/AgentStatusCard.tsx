import Link from "next/link";
import { cn } from "@/lib/utils";
import type { AgentCommandCenterCard } from "@/aletheia/agentops/agentStatus";
import type { ArtifactRef, ProfessionalAgentStatus } from "@/aletheia/agentops";

const statusClasses: Record<ProfessionalAgentStatus, string> = {
  idle: "bg-gray-300 text-gray-500",
  working: "bg-blue-500 text-blue-700",
  blocked: "bg-red-500 text-red-700",
  review_needed: "bg-amber-500 text-amber-700",
  waiting_for_approval: "bg-amber-500 text-amber-700",
  done: "bg-emerald-500 text-emerald-700",
  failed: "bg-red-500 text-red-700",
};

function artifactLabel(type: string) {
  return type.replaceAll("_", " ");
}

function StatusText({
  status,
  label,
}: {
  status: ProfessionalAgentStatus;
  label: string;
}) {
  const [dotClass, textClass] = statusClasses[status].split(" ");

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", textClass)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
      {label}
    </span>
  );
}

export function AgentStatusCard({
  card,
  artifactHref,
}: {
  card: AgentCommandCenterCard;
  artifactHref: (artifact: ArtifactRef) => string;
}) {
  const blocker =
    card.agent.blocked_reason ||
    (card.agent.status === "waiting_for_approval"
      ? "Human approval is required before this agent can continue."
      : "");

  return (
    <article
      data-testid="agent-status-card"
      className="flex min-h-[292px] flex-col rounded-lg border border-gray-200 bg-white p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500">
            {card.roleLabel}
          </p>
          <h3 className="mt-1 text-base font-semibold leading-6 text-gray-950">
            {card.agent.name}
          </h3>
        </div>
        <StatusText status={card.agent.status} label={card.statusLabel} />
      </div>

      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-xs font-medium text-gray-500">
            Current task
          </dt>
          <dd className="mt-1 leading-5 text-gray-700">
            {card.agent.current_task ?? "No active task assigned."}
          </dd>
        </div>

        {blocker && (
          <div className="border-l border-red-300 pl-3">
            <dt className="text-xs font-medium text-red-700">
              Missing input
            </dt>
            <dd className="mt-1 leading-5 text-red-800">{blocker}</dd>
          </div>
        )}

        <div>
          <dt className="text-xs font-medium text-gray-500">
            Last run
          </dt>
          <dd className="mt-1 font-medium leading-5 text-gray-800">
            {card.lastRunLabel}
          </dd>
        </div>

        <div>
          <dt className="text-xs font-medium text-gray-500">
            Next action
          </dt>
          <dd className="mt-1 leading-5 text-gray-700">
            {card.agent.next_action ?? "Wait for upstream workflow change."}
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-gray-100 pt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-gray-500">
            Related artifacts
          </p>
          {card.reviewNeeded && (
            <span className="text-xs text-amber-700">
              Expert attention
            </span>
          )}
        </div>

        <div className="mt-2 space-y-2">
          {card.relatedArtifacts.length === 0 ? (
            <p className="text-sm text-gray-500">No produced artifacts yet.</p>
          ) : (
            card.relatedArtifacts.map((artifact) => (
              <Link
                key={`${artifact.type}-${artifact.id}`}
                href={artifactHref(artifact)}
                className="block rounded-md border border-gray-100 px-3 py-2 text-sm transition-colors hover:border-gray-200 hover:bg-gray-50"
              >
                <span className="block truncate font-medium text-gray-800">
                  {artifact.title ?? artifact.id}
                </span>
                <span className="mt-0.5 block text-xs capitalize text-gray-500">
                  {artifactLabel(artifact.type)}
                </span>
              </Link>
            ))
          )}
        </div>
      </div>
    </article>
  );
}
