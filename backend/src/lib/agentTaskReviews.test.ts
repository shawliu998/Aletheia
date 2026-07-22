import assert from "node:assert/strict";
import test from "node:test";
import { loadApprovedExport } from "./agentTaskReviews";

type EqCall = { column: string; value: unknown };

function chain(result: unknown, eqCalls: EqCall[]) {
  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      eqCalls.push({ column, value });
      return query;
    },
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: result, error: null }),
  };
  return query;
}

test("final export fails closed when the latest review requests changes", async () => {
  const taskFilters: EqCall[] = [];
  const decisionFilters: EqCall[] = [];
  const touchedTables: string[] = [];
  const db = {
    from(table: string) {
      touchedTables.push(table);
      if (table === "agent_tasks") {
        return chain({ id: "task-1" }, taskFilters);
      }
      if (table === "agent_task_review_decisions") {
        return chain(
          {
            id: "decision-2",
            status: "changes_requested",
            artifact_snapshot: [],
            created_at: "2026-07-22T12:00:00.000Z",
          },
          decisionFilters,
        );
      }
      throw new Error(`Unexpected table access: ${table}`);
    },
  };

  await assert.rejects(
    loadApprovedExport(db as never, "task-1", "user-1", "artifact-1"),
    /most recent review decision requests changes/,
  );
  assert.deepEqual(taskFilters, [
    { column: "id", value: "task-1" },
    { column: "user_id", value: "user-1" },
  ]);
  assert.deepEqual(decisionFilters, [
    { column: "task_id", value: "task-1" },
  ]);
  assert.deepEqual(touchedTables, [
    "agent_tasks",
    "agent_task_review_decisions",
  ]);
});
