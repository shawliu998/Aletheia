import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildAgentReviewVersionState,
  deriveAgentReviewStatus,
} from "../src/lib/agentTaskReviewVersions";
import { approvedArtifactBytesMatch } from "../src/lib/agentTaskReviews";

const links = [
  { artifact_type: "draft" as const, artifact_id: "memo", purpose: "Memo" },
  {
    artifact_type: "tabular_review" as const,
    artifact_id: "matrix",
    purpose: "Risk matrix",
  },
];
const versions = [
  ["memo_v1", "memo", 1, "Memo V1.docx", "docx"],
  ["memo_v2", "memo", 2, "Memo V2.docx", "docx"],
  ["matrix_v1", "matrix", 1, "Matrix V1.xlsx", "xlsx"],
  ["matrix_v2", "matrix", 2, "Matrix V2.xlsx", "xlsx"],
].map(([id, document_id, version_number, filename, file_type]) => ({
  id: id as string,
  document_id: document_id as string,
  version_number: version_number as number,
  filename: filename as string,
  file_type: file_type as string,
  deleted_at: null,
}));

function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function approval(id: string, memo: string, matrix: string) {
  return {
    id,
    created_at: "2026-07-21T08:00:00.000Z",
    artifact_snapshot: [
      {
        artifact_type: "draft",
        artifact_id: "memo",
        document_id: "memo",
        purpose: "Memo",
        version_id: memo,
        version_number: memo.endsWith("v1") ? 1 : 2,
        filename: "Memo.docx",
        file_type: "docx",
        size_bytes: 7,
        sha256: digest("memo-v1"),
      },
      {
        artifact_type: "tabular_review",
        artifact_id: "matrix",
        document_id: "matrix",
        purpose: "Risk matrix",
        version_id: matrix,
        version_number: matrix.endsWith("v1") ? 1 : 2,
        filename: "Matrix.xlsx",
        file_type: "xlsx",
        size_bytes: 9,
        sha256: digest("matrix-v1"),
      },
    ],
  };
}

function state(
  memo: string | null,
  matrix: string | null,
  approved: ReturnType<typeof approval>,
) {
  return buildAgentReviewVersionState(
    links,
    [
      { id: "memo", current_version_id: memo },
      { id: "matrix", current_version_id: matrix },
    ],
    versions,
    approved,
  );
}

function main() {
  const v1 = approval("approval_v1", "memo_v1", "matrix_v1");
  const exact = state("memo_v1", "matrix_v1", v1);
  assert.equal(exact.has_unapproved_changes, false);
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", exact),
    "approved",
  );

  const wordEdited = state("memo_v2", "matrix_v1", v1);
  assert.equal(wordEdited.current_artifacts[0]?.edited_after_approval, true);
  assert.equal(wordEdited.current_artifacts[1]?.edited_after_approval, false);
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", wordEdited),
    "review_required",
  );

  const bothEdited = state("memo_v2", "matrix_v2", v1);
  assert.equal(
    bothEdited.current_artifacts.filter((item) => item.edited_after_approval)
      .length,
    2,
    "Word and Excel versions must be compared independently",
  );
  assert.equal(
    deriveAgentReviewStatus("completed", "changes_requested", bothEdited),
    "changes_requested",
  );

  const v2 = state(
    "memo_v2",
    "matrix_v2",
    approval("approval_v2", "memo_v2", "matrix_v2"),
  );
  assert.equal(v2.has_unapproved_changes, false);
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", v2),
    "approved",
  );

  const missing = state("missing", "matrix_v1", v1);
  assert.equal(missing.current_artifacts[0]?.current_version_available, false);
  assert.equal(missing.has_unapproved_changes, true);

  const lockedV1 = v1.artifact_snapshot[0]!;
  assert.equal(
    approvedArtifactBytesMatch(lockedV1, Buffer.from("memo-v1")),
    true,
  );
  assert.equal(
    approvedArtifactBytesMatch(lockedV1, Buffer.from("memo-v2")),
    false,
    "V2 bytes must not pass the locked V1 hash",
  );

  console.log(
    JSON.stringify(
      { ok: true, suite: "agent-task-review-version-smoke-v1" },
      null,
      2,
    ),
  );
}

main();
