import type { ProfessionalSkill } from "@/aletheia/agentops";
import { cn } from "@/lib/utils";

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function statusClass(status: ProfessionalSkill["approval_status"]) {
  if (status === "approved") {
    return "bg-emerald-500 text-emerald-700";
  }
  if (status === "rejected") {
    return "bg-red-500 text-red-700";
  }
  if (status === "deprecated") {
    return "bg-gray-400 text-gray-500";
  }
  return "bg-amber-500 text-amber-700";
}

function StatusMark({ status }: { status: ProfessionalSkill["approval_status"] }) {
  const classes = statusClass(status).split(" ");

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", classes[1])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", classes[0])} />
      {titleize(status)}
    </span>
  );
}

export function SkillCandidateList({
  existingSkills,
  suggestedSkills,
}: {
  existingSkills: ProfessionalSkill[];
  suggestedSkills: ProfessionalSkill[];
}) {
  const approvedSkills = existingSkills.filter(
    (skill) => skill.approval_status === "approved",
  );
  const candidateSkills = [
    ...existingSkills.filter((skill) => skill.approval_status === "candidate"),
    ...suggestedSkills,
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-950">Candidate skills</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Inactive until review approval.
            </p>
          </div>
          <span className="text-xs font-medium text-amber-700">
            Approval required
          </span>
        </div>

        <div className="divide-y divide-gray-100">
          {candidateSkills.length === 0 ? (
            <p className="px-4 py-5 text-sm text-gray-500">
              No repeated feedback pattern has crossed the candidate threshold.
            </p>
          ) : (
            candidateSkills.map((skill, index) => (
              <article
                key={`${skill.id}-${skill.version}-${index}`}
                className="px-4 py-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-950">
                      {skill.name}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                      {skill.description}
                    </p>
                  </div>
                  <StatusMark status={skill.approval_status} />
                </div>
                <div className="mt-3 grid gap-3 text-xs text-gray-600 sm:grid-cols-[1fr_auto]">
                  <p>
                    <span className="font-medium text-gray-800">Triggers</span>{" "}
                    {skill.trigger_conditions.join("; ")}
                  </p>
                  <p>
                    <span className="font-medium text-gray-800">Eval cases</span>{" "}
                    {skill.created_from_eval_case_ids.length || "review/gate pattern"}
                  </p>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-950">
            Approved playbook skills
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Active skills backed by human approval.
          </p>
        </div>

        <div className="divide-y divide-gray-100">
          {approvedSkills.length === 0 ? (
            <p className="px-4 py-5 text-sm text-gray-500">
              No human-approved playbook skill is active for this workspace.
            </p>
          ) : (
            approvedSkills.map((skill, index) => (
              <article
                key={`${skill.id}-${skill.version}-${index}`}
                className="px-4 py-4"
              >
                <div className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-gray-950">
                        {skill.name}
                      </p>
                      <span className="text-xs text-gray-500">
                        v{skill.version}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                      {skill.description}
                    </p>
                    <p className="mt-2 text-xs text-gray-500">
                      {skill.created_from_eval_case_ids.length} eval case
                      {skill.created_from_eval_case_ids.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
