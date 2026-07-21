import {
  advanceAgentTask,
  getAgentTaskSnapshot,
  linkAgentTaskArtifacts,
  recordAgentTaskCheckpoint,
  stopAgentTask,
  verifierRepairAlreadyAttempted,
} from "./agentTasks";
import {
  executeAgentStep,
  isAgentTaskExecutionInterrupted,
  isTransientModelError,
  verifyTaskCitationLinks,
} from "./agentStepExecutor";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export function agentTaskExecutionErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Model or tool execution failed";
  if (/deepseek api key/i.test(message)) {
    return "DeepSeek is unavailable. Configure a DeepSeek API key in Settings before running this task.";
  }
  if (/gemini api key/i.test(message)) {
    return "Gemini is unavailable. Configure a Gemini API key in Settings before running this task.";
  }
  if (/api key is not configured/i.test(message)) {
    return "The selected model is unavailable. Configure its API key in Settings before running this task.";
  }
  if (isTransientModelError(error)) {
    return "The selected model is temporarily unavailable.";
  }
  return message;
}

async function taskCanContinue(db: Db, taskId: string, userId: string) {
  const snapshot = await getAgentTaskSnapshot(db, taskId, userId);
  return {
    snapshot,
    active: Boolean(
      snapshot && ["running", "verifying"].includes(snapshot.task.status),
    ),
  };
}

export async function advanceAgentTaskExecution(input: {
  db: Db;
  taskId: string;
  userId: string;
  userEmail?: string;
}) {
  const { db, taskId, userId, userEmail } = input;
  const shouldContinue = async () =>
    (await taskCanContinue(db, taskId, userId)).active;
  const current = await getAgentTaskSnapshot(db, taskId, userId);
  if (!current) return null;
  if (current.task.status === "queued") {
    return advanceAgentTask(db, taskId, userId);
  }
  if (!["running", "verifying"].includes(current.task.status)) {
    return current;
  }

  let execution;
  try {
    execution = await executeAgentStep({
      db,
      snapshot: current,
      userId,
      userEmail,
      shouldContinue,
    });
  } catch (error) {
    if (isAgentTaskExecutionInterrupted(error)) {
      return getAgentTaskSnapshot(db, taskId, userId);
    }
    if (isTransientModelError(error)) throw error;
    return stopAgentTask(db, taskId, userId, {
      status: "failed",
      summary: agentTaskExecutionErrorMessage(error),
    });
  }

  const afterExecution = await taskCanContinue(db, taskId, userId);
  if (!afterExecution.active) return afterExecution.snapshot;
  if (execution.waitingForInput) {
    return stopAgentTask(db, taskId, userId, {
      status: "waiting_input",
      summary: execution.summary,
    });
  }

  if (current.task.status === "verifying") {
    execution.citationCheck = await verifyTaskCitationLinks(db, current);
    const allArtifacts = [...current.artifacts, ...execution.artifacts];
    const missingDeliverables = () =>
      [
        !allArtifacts.some((artifact) => artifact.purpose === "Risk matrix")
          ? "risk matrix"
          : null,
        !allArtifacts.some(
          (artifact) => artifact.purpose === "Review memo draft",
        )
          ? "review memo draft"
          : null,
      ].filter((value): value is string => Boolean(value));
    const summaryHasGap = /\bGAP\b/i.test(execution.summary);
    const citationGap =
      execution.citationCheck.total > 0 && execution.citationCheck.missing > 0;
    const initialGaps = missingDeliverables();

    if (initialGaps.length || summaryHasGap || citationGap) {
      const reasons = [
        initialGaps.length ? `missing ${initialGaps.join(" and ")}` : null,
        summaryHasGap ? "the verifier reported one or more GAP findings" : null,
        citationGap
          ? `${execution.citationCheck.missing} citation(s) could not be relocated`
          : null,
      ]
        .filter(Boolean)
        .join("; ");
      if (verifierRepairAlreadyAttempted(current.task)) {
        return stopAgentTask(db, taskId, userId, {
          status: "failed",
          summary: `Verification blocked after one repair pass: ${reasons}.`,
        });
      }

      await recordAgentTaskCheckpoint(
        db,
        taskId,
        userId,
        `Verifier repair 1/1 started: ${reasons}.`,
      );
      let repair;
      let recheck;
      try {
        repair = await executeAgentStep({
          db,
          snapshot: current,
          userId,
          userEmail,
          shouldContinue,
          instructionOverride: `This is the single permitted repair pass. Repair: ${reasons}. Re-read the sources, update or recreate only the affected deliverables, and preserve lawyer-review status.`,
        });
        const afterRepair = await taskCanContinue(db, taskId, userId);
        if (!afterRepair.active) return afterRepair.snapshot;
        await linkAgentTaskArtifacts(db, taskId, userId, repair.artifacts);
        const repairedSnapshot = {
          ...current,
          artifacts: [
            ...current.artifacts,
            ...repair.artifacts.map((artifact) => ({
              task_id: taskId,
              ...artifact,
            })),
          ],
        };
        recheck = await executeAgentStep({
          db,
          snapshot: repairedSnapshot,
          userId,
          userEmail,
          shouldContinue,
          instructionOverride:
            "Re-run the four verifier checks after the one permitted repair. Do not repair again. Return PASS or GAP for every check.",
        });
        const afterRecheck = await taskCanContinue(db, taskId, userId);
        if (!afterRecheck.active) return afterRecheck.snapshot;
        recheck.citationCheck = await verifyTaskCitationLinks(db, {
          ...repairedSnapshot,
          artifacts: [
            ...repairedSnapshot.artifacts,
            ...recheck.artifacts.map((artifact) => ({
              task_id: taskId,
              ...artifact,
            })),
          ],
        });
      } catch (error) {
        if (isAgentTaskExecutionInterrupted(error)) {
          return getAgentTaskSnapshot(db, taskId, userId);
        }
        if (isTransientModelError(error)) throw error;
        return stopAgentTask(db, taskId, userId, {
          status: "failed",
          summary: agentTaskExecutionErrorMessage(error),
        });
      }

      allArtifacts.push(...repair.artifacts);
      const remaining = missingDeliverables();
      if (
        remaining.length ||
        /\bGAP\b/i.test(recheck.summary) ||
        recheck.citationCheck.missing > 0
      ) {
        const missing = remaining.length
          ? remaining.join(" and ")
          : "one or more verifier checks";
        return stopAgentTask(db, taskId, userId, {
          status: "failed",
          summary: `Verification blocked after one repair pass: ${missing}.`,
        });
      }
      execution = {
        ...recheck,
        summary: `Verifier repair 1/1 completed.\n${recheck.summary}`,
        artifacts: [
          ...execution.artifacts,
          ...repair.artifacts,
          ...recheck.artifacts,
        ],
      };
    } else if (execution.citationCheck.total === 0) {
      return stopAgentTask(db, taskId, userId, {
        status: "failed",
        summary:
          "Verification blocked: no source citations were available for deterministic relocation checks.",
      });
    }
  }

  const beforeCommit = await taskCanContinue(db, taskId, userId);
  if (!beforeCommit.active) return beforeCommit.snapshot;
  return advanceAgentTask(db, taskId, userId, execution);
}
