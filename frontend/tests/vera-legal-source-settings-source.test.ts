import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  submitVeraCredentialInput,
  VeraCredentialInputError,
} from "../src/app/components/models/modelCredentialSubmission.ts";
import { translateMessage } from "../src/app/i18n/messages.ts";
import { VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS } from "../src/app/lib/veraCredentialLimits.ts";

const FRONTEND_ROOT = path.resolve(__dirname, "..");
const PAGE_PATH = "src/app/(pages)/settings/legal-sources/page.tsx";

function source(relativePath: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");
}

test("Settings owns the Active legal-provider surface without a Legacy facade", () => {
  const layout = source("src/app/(pages)/settings/layout.tsx");
  const page = source(PAGE_PATH);
  const api = source("src/app/lib/veraLegalSourceApi.ts");

  assert.match(layout, /href: "\/settings\/legal-sources"/);
  assert.match(layout, /labelKey: "settings\.tabs\.legalSources"/);
  assert.match(api, /veraApiRequest/);
  assert.match(api, /"\/legal-providers"/);
  assert.match(api, /vera-workspace-legal-provider-hub-v1/);
  assert.match(api, /parseVeraLegalSourceProviderResponse/);
  assert.doesNotMatch(api, /aletheiaApi|\/aletheia\/providers/);

  for (const action of [
    "createVeraLegalSourceProvider",
    "listVeraLegalSourceProviders",
    "saveVeraLegalSourceSecret",
    "removeVeraLegalSourceSecret",
    "testVeraLegalSourceProvider",
    "enableVeraLegalSourceProvider",
    "disableVeraLegalSourceProvider",
  ]) {
    assert.ok(page.includes(action), action);
  }
  assert.match(page, /AccountSection/);
  assert.match(page, /ConfirmPopup/);
  assert.match(page, /profile\.usage_policy\.local_processing/);
  assert.match(page, /settings\.legalSources\.policy\.retention/);
  assert.match(page, /settings\.legalSources\.policy\.modelUse/);
  assert.match(page, /settings\.legalSources\.policy\.export/);
  assert.match(page, /settings\.legalSources\.policy\.values\.notDeclared/);
  assert.match(page, /settings\.legalSources\.policy\.values\.transientOnly/);
  assert.match(page, /settings\.legalSources\.policy\.values\.prohibited/);
  assert.doesNotMatch(page, /fetch\(|\/aletheia\//);
});

test("UI is YuanDian-only, renders all eight backend states, and never equates a passed test with ready", () => {
  const page = source(PAGE_PATH);

  assert.match(page, /settings\.legalSources\.providers\.yuandian/);
  assert.doesNotMatch(page, /providers\.pkulaw|providers\.wolters/);
  for (const status of [
    "unavailable",
    "not_configured",
    "configured_unverified",
    "ready",
    "authentication_failed",
    "license_restricted",
    "activation_gate_closed",
    "temporarily_unavailable",
  ]) {
    assert.ok(page.includes(`${status}:`), status);
  }
  assert.match(page, /const ready = status === "ready"/);
  assert.match(page, /profile\.status === "activation_gate_closed"/);
  assert.match(page, /profile\.connection_test\?\.status === "passed"/);
  assert.doesNotMatch(page, /connection_test[^\n]*\?[^\n]*"ready"/);
  assert.match(page, /createVeraLegalSourceProvider\(\)/);
  assert.doesNotMatch(page, /setProfiles\(\[[\s\S]*provider:\s*"yuandian"/);
});

test("legal-provider secret remains a one-shot uncontrolled DOM value", () => {
  const page = source(PAGE_PATH);
  const submission = source(
    "src/app/components/models/modelCredentialSubmission.ts",
  );
  const input = page.match(/<input[\s\S]*?\/>/)?.[0];

  assert(input, "write-only legal-provider password input exists");
  assert.match(page, /useRef<HTMLInputElement>\(null\)/);
  assert.match(input, /type="password"/);
  assert.match(input, /autoComplete="off"/);
  assert.match(
    input,
    /maxLength=\{VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS\}/,
  );
  assert.doesNotMatch(input, /\bvalue=|\bdefaultValue=|\bname=/);
  assert.match(page, /submitVeraCredentialInput\(\s*field/);
  assert.match(page, /finally \{\s*field\.value = "";/);
  assert.match(submission, /const secret = field\.value;\s*field\.value = "";/);
  assert.match(submission, /finally\s*\{\s*field\.value = "";/);

  assert.doesNotMatch(
    page,
    /useState[^;\n]*(secret|credentialReference|credential_ref|rawUrl|endpointUrl|mcpSchema)/i,
  );
  assert.doesNotMatch(
    page,
    /credential_reference|credentialRef|raw_url|endpointUrl|https?:\/\/|mcp_schema/,
  );
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB|console\./);
});

test("legal-provider credential limit remains independently enforced", async () => {
  assert.equal(VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS, 32_768);
  const boundary = {
    value: "x".repeat(VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS),
  };
  let stored = false;
  await submitVeraCredentialInput(
    boundary,
    async () => {
      stored = true;
    },
    { maxCharacters: VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS },
  );
  assert.equal(stored, true);
  assert.equal(boundary.value, "");

  const oversized = {
    value: "x".repeat(VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS + 1),
  };
  await assert.rejects(
    submitVeraCredentialInput(oversized, async () => undefined, {
      maxCharacters: VERA_LEGAL_SOURCE_CREDENTIAL_MAX_CHARACTERS,
    }),
    VeraCredentialInputError,
  );
  assert.equal(oversized.value, "");
});

test("Chinese and English copy explicitly preserves activation-gate semantics", () => {
  assert.equal(
    translateMessage("zh-CN", "settings.tabs.legalSources"),
    "法律数据源",
  );
  assert.equal(
    translateMessage("en-US", "settings.tabs.legalSources"),
    "Legal sources",
  );
  assert.match(
    translateMessage("zh-CN", "settings.legalSources.localStatus.body"),
    /不等于“已连接”.*不等于生产可用/,
  );
  assert.match(
    translateMessage("en-US", "settings.legalSources.localStatus.body"),
    /does not mean connected.*does not mean production-ready/,
  );
  assert.match(
    translateMessage("en-US", "settings.legalSources.activation.gateClosed"),
    /never presented as ready/,
  );
});
