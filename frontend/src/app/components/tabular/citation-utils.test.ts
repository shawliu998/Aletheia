import assert from "node:assert/strict";
import test from "node:test";

import { resolveCellCitationFromExcerpt } from "./citation-utils";

test("resolves a chat excerpt to its single page citation", () => {
    const citation = resolveCellCitationFromExcerpt(
        "The agreement renews automatically. [[page:4||quote:The Term shall automatically renew for successive one-year periods.]]",
        undefined,
        "The agreement renews automatically.",
    );

    assert.deepEqual(citation, {
        page: 4,
        quote: "The Term shall automatically renew for successive one-year periods.",
        citationRef: 1,
        section: "summary",
    });
});

test("selects the source citation closest to the quoted conclusion", () => {
    const citation = resolveCellCitationFromExcerpt(
        [
            "Liability is capped at fees paid.",
            "[[page:8||quote:Liability shall not exceed fees paid in the preceding twelve months.]]",
            "Indirect damages are excluded.",
            "[[page:9||quote:Neither party shall be liable for indirect or consequential damages.]]",
        ].join(" "),
        undefined,
        "Indirect damages are excluded.",
    );

    assert.equal(citation?.page, 9);
    assert.equal(citation?.citationRef, 2);
});

test("preserves the combined citation number for a reasoning source", () => {
    const citation = resolveCellCitationFromExcerpt(
        "The notice period is thirty days. [[page:2||quote:Notice must be delivered thirty days before renewal.]]",
        "因此，错过通知窗口会导致自动续期。 [[page:3||quote:未在续期日前三十日通知的，本合同自动续期。]]",
        "因此，错过通知窗口会导致自动续期。",
    );

    assert.equal(citation?.page, 3);
    assert.equal(citation?.citationRef, 2);
    assert.equal(citation?.section, "reasoning");
});

test("resolves spreadsheet citations without changing their locator", () => {
    const citation = resolveCellCitationFromExcerpt(
        "The total exposure is 125000. [[sheet:Risk Matrix||cell:F18||quote:125000]]",
        undefined,
        "The total exposure is 125000.",
    );

    assert.equal(citation?.sheet, "Risk Matrix");
    assert.equal(citation?.cell, "F18");
});

test("fails closed when an unmatched excerpt has several possible sources", () => {
    const citation = resolveCellCitationFromExcerpt(
        "First conclusion. [[page:1||quote:First source.]] Second conclusion. [[page:2||quote:Second source.]]",
        undefined,
        "A conclusion that is not present in the cell.",
    );

    assert.equal(citation, undefined);
});

test("uses the only available source when the excerpt formatting drifts", () => {
    const citation = resolveCellCitationFromExcerpt(
        "**Termination:** thirty days. [[page:6||quote:Either party may terminate on thirty days' notice.]]",
        undefined,
        "Termination is available on 30 days notice.",
    );

    assert.equal(citation?.page, 6);
});
