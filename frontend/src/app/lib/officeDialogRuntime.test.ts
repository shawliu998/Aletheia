import assert from "node:assert/strict";
import test from "node:test";
import {
    displayOfficeDialog,
    messageOfficeTaskPane,
    OFFICE_DIALOG_OPEN_TIMEOUT_MS,
    readyOfficeRuntime,
    type OfficeDialogChildUi,
    type OfficeDialogUi,
} from "./officeDialogRuntime.ts";

test("Office dialog launch keeps the Office UI receiver", () => {
    let callbackResult: unknown;
    const ui: OfficeDialogUi<{ id: string }> = {
        displayDialogAsync(this: OfficeDialogUi<{ id: string }>, url, options, callback) {
            assert.strictEqual(this, ui);
            assert.equal(url, "https://vera.test/office/auth/dialog");
            assert.deepEqual(options, {
                height: 65,
                width: 35,
                displayInIframe: false,
            });
            callback({ status: "succeeded", value: { id: "dialog" } });
        },
    };

    displayOfficeDialog(
        ui,
        "https://vera.test/office/auth/dialog",
        { height: 65, width: 35, displayInIframe: false },
        (result) => {
            callbackResult = result;
        },
    );

    assert.deepEqual(callbackResult, {
        status: "succeeded",
        value: { id: "dialog" },
    });
});

test("Office dialog message keeps the Office UI receiver", () => {
    const messages: Array<{ message: string; origin?: string }> = [];
    const ui: OfficeDialogChildUi = {
        messageParent(this: OfficeDialogChildUi, message, options) {
            assert.strictEqual(this, ui);
            messages.push({ message, origin: options?.targetOrigin });
        },
    };

    messageOfficeTaskPane(ui, "{\"status\":\"success\"}", {
        targetOrigin: "https://vera.test",
    });

    assert.deepEqual(messages, [
        { message: "{\"status\":\"success\"}", origin: "https://vera.test" },
    ]);
});

test("Office host readiness keeps the Office runtime receiver", async () => {
    const runtime = {
        async onReady() {
            assert.equal(this, runtime);
            return { host: "Word" };
        },
    };

    assert.deepEqual(await readyOfficeRuntime(runtime), { host: "Word" });
});

test("Office dialog fallback timeout stays within the requested recovery window", () => {
    assert.ok(OFFICE_DIALOG_OPEN_TIMEOUT_MS >= 8_000);
    assert.ok(OFFICE_DIALOG_OPEN_TIMEOUT_MS <= 10_000);
});
