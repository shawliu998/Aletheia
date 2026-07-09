import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

type SmokeState = {
  projects: Record<string, { matterId: string }>;
};

function matterIdFor(projectName: string) {
  const state = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "test-results", "aletheia-ui-smoke-state.json"),
      "utf8",
    ),
  ) as SmokeState;
  const project = state.projects[projectName];
  if (!project?.matterId) {
    throw new Error(`Missing UI smoke matter for ${projectName}`);
  }
  return project.matterId;
}

test("external-source workpaper is opt-in, reviewable, and persisted", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(
    `/aletheia/matters/${matterIdFor(testInfo.project.name)}/agentops`,
  );
  const panel = page.getByTestId("external-source-workpaper-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(
    "Automatic retrieval requires a configured HTTPS allowlist",
  );

  await page.getByTestId("legal-qa-question").fill(
    "What written notice is required before termination?",
  );
  await page.getByTestId("draft-legal-qa-answer").click();
  await expect(page.getByTestId("legal-qa-source-count")).toContainText(
    "retained source chunk",
  );
  await expect(page.getByTestId("legal-qa-answer")).toContainText(
    "Preliminary answer",
  );
  await page.getByTestId("record-legal-qa-answer").click();
  await expect(page.getByTestId("legal-qa-status")).toContainText(
    "Legal Q&A answer recorded",
  );
  await expect(page.getByTestId("legal-qa-record")).toContainText(
    "What written notice is required before termination?",
  );
  await page.locator('[data-testid^="accept-legal-qa-review-"]').click();
  await expect(page.getByTestId("legal-qa-status")).toContainText(
    "Legal Q&A review accepted",
  );
  await page.locator('[data-testid^="approve-legal-qa-"]').click();
  await expect(page.getByTestId("legal-qa-status")).toContainText(
    "Legal Q&A answer approved",
  );
  await expect(page.getByTestId("legal-qa-record")).toContainText("accepted");

  await page
    .getByTestId("word-handoff-selected-text")
    .fill("The agreement requires thirty days written notice before termination.");
  await page
    .getByTestId("word-handoff-suggested-edit")
    .fill("Clarify the notice delivery method and effective date.");
  await page.getByTestId("record-word-addin-handoff").click();
  await expect(page.getByTestId("word-handoff-status")).toContainText(
    "Word Add-in handoff recorded",
  );
  await expect(page.getByTestId("word-handoff-record")).toContainText(
    "no Word mutation applied",
  );
  await page.locator('[data-testid^="accept-word-handoff-review-"]').click();
  await expect(page.getByTestId("word-handoff-status")).toContainText(
    "Word Add-in handoff review accepted",
  );
  await page.locator('[data-testid^="approve-word-handoff-"]').click();
  await expect(page.getByTestId("word-handoff-status")).toContainText(
    "Word Add-in handoff approved",
  );
  await expect(page.getByTestId("word-handoff-record")).toContainText(
    "accepted",
  );

  await page
    .getByTestId("preference-learning-proposal")
    .fill("Prefer a stricter notice-period risk caveat in this matter.");
  await page.getByTestId("preference-learning-opt-in").check();
  await page.getByTestId("record-preference-learning-proposal").click();
  await expect(page.getByTestId("preference-learning-status")).toContainText(
    "Preference proposal recorded",
  );
  await expect(page.getByTestId("preference-learning-record")).toContainText(
    "no automatic application",
  );
  await page.locator('[data-testid^="accept-preference-review-"]').click();
  await expect(page.getByTestId("preference-learning-status")).toContainText(
    "Preference review accepted",
  );
  await page.locator('[data-testid^="approve-preference-candidate-"]').click();
  await expect(page.getByTestId("preference-learning-status")).toContainText(
    "Preference mapped to an approved matter playbook",
  );
  await expect(page.getByTestId("preference-learning-record")).toContainText(
    "approved playbook mapping",
  );

  await page.getByTestId("external-source-query").fill(
    "issuer public-source verification",
  );
  await page
    .getByTestId("external-source-url")
    .fill("https://example.test/issuer");
  await page.getByTestId("external-source-observation").fill(
    "Captured public issuer profile for counsel review.",
  );
  await page.getByTestId("external-source-opt-in").check();
  await page.getByTestId("record-external-source-workpaper").click();

  await expect(
    page.getByTestId("external-source-workpaper-status"),
  ).toContainText("External-source workpaper recorded");
  await expect(page.getByTestId("external-source-workpaper-record")).toContainText(
    "https://example.test/issuer",
  );
  await expect(page.getByTestId("external-source-workpaper-record")).toContainText(
    "needs review",
  );
  await expect(page.getByTestId("external-source-workpaper-record")).toContainText(
    "Provenance validated",
  );

  const graphPanel = page.getByTestId("shareholder-penetration-graph-panel");
  await expect(graphPanel).toBeVisible();
  await page.getByTestId("shareholder-graph-issuer").fill("Issuer Co.");
  await page
    .getByTestId("shareholder-graph-shareholder")
    .fill("Holding Co.");
  await page
    .getByTestId("shareholder-graph-beneficial-owner")
    .fill("Controller A; Controller B");
  await page.getByTestId("shareholder-graph-ownership-percentage").fill("55");
  await page.getByTestId("shareholder-graph-evidence-status").selectOption("conflicting");
  await page.getByTestId("shareholder-graph-conflict-note").fill(
    "The retained source conflicts with a prior ownership disclosure.",
  );
  await page.getByTestId("record-shareholder-penetration-graph").click();
  await expect(page.getByTestId("shareholder-graph-status")).toContainText(
    "Shareholder penetration graph recorded",
  );
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("Controller A");
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("Controller B");
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("Holding Co.");
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("Issuer Co.");
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("55% recorded ownership");
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("prior ownership disclosure");
  await page
    .locator('[data-testid^="accept-shareholder-graph-review-"]')
    .click();
  await expect(page.getByTestId("shareholder-graph-status")).toContainText(
    "Shareholder graph review accepted",
  );
  await page
    .locator('[data-testid^="approve-shareholder-graph-"]')
    .click();
  await expect(page.getByTestId("shareholder-graph-status")).toContainText(
    "Shareholder penetration graph approved",
  );
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("accepted");

  await page.reload();
  await expect(page.getByTestId("external-source-workpaper-record")).toContainText(
    "https://example.test/issuer",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "external_source_workpaper_persisted",
  );
  await expect(page.getByTestId("legal-qa-record")).toContainText(
    "What written notice is required before termination?",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "legal_qa_answer_persisted",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "legal_qa_answer_approved",
  );
  await expect(page.getByTestId("word-handoff-record")).toContainText(
    "no Word mutation applied",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "word_addin_handoff_persisted",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "word_addin_handoff_approved",
  );
  await expect(page.getByTestId("preference-learning-record")).toContainText(
    "no automatic application",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "preference_learning_proposal_recorded",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "preference_learning_candidate_approved",
  );
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("Controller A");
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "shareholder_penetration_graph_persisted",
  );
  await expect(page.getByTestId("adapter-backed-command-center")).toContainText(
    "shareholder_penetration_graph_approved",
  );
  await expect(
    page.getByTestId("shareholder-penetration-graph-record"),
  ).toContainText("accepted");
  expect(consoleErrors).toEqual([]);
});
