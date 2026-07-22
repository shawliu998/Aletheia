import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
const addinDir = path.join(repositoryRoot, "office-addin");
const xmlPath = path.join(addinDir, "word-manifest.xml");
const unifiedPath = path.join(addinDir, "manifest.json");
const gatePath = path.join(
    repositoryRoot,
    "frontend/src/app/components/office/OfficeAuthGate.tsx",
);
const dialogPath = path.join(
    repositoryRoot,
    "frontend/src/app/office/auth/dialog/page.tsx",
);
const dialogRuntimePath = path.join(
    repositoryRoot,
    "frontend/src/app/lib/officeDialogRuntime.ts",
);

const [xml, unifiedSource, gateSource, dialogSource, dialogRuntimeSource] = await Promise.all([
    readFile(xmlPath, "utf8"),
    readFile(unifiedPath, "utf8"),
    readFile(gatePath, "utf8"),
    readFile(dialogPath, "utf8"),
    readFile(dialogRuntimePath, "utf8"),
]);
const unified = JSON.parse(unifiedSource);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function xmlValue(element) {
    const match = xml.match(new RegExp(`<${element}[^>]*>([^<]+)</${element}>`));
    return match?.[1]?.trim() ?? null;
}

function walk(value, visit) {
    if (Array.isArray(value)) {
        value.forEach((entry) => walk(entry, visit));
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
        visit(key, entry);
        walk(entry, visit);
    }
}

function findOne(values, predicate, label) {
    const match = values.find(predicate);
    assert(match, `Unified manifest is missing ${label}.`);
    return match;
}

assert(!/Hermes/i.test(xml), "The XML manifest still contains Hermes branding.");
assert(
    !/Hermes/i.test(unifiedSource),
    "The unified manifest still contains Hermes branding.",
);
assert(xmlValue("ProviderName") === "Vera", "XML provider must be Vera.");
assert(
    xmlValue("Permissions") === "ReadWriteDocument",
    "XML manifest must request ReadWriteDocument for tracked changes and comments.",
);
assert(
    xml.includes('DefaultValue="https://localhost:3000/office/word"'),
    "XML manifest must use the HTTPS Word taskpane route.",
);

const xmlId = xmlValue("Id");
assert(xmlId, "XML manifest ID is missing.");
assert(unified.id && unified.id !== xmlId, "Unified and XML manifests need distinct IDs.");
assert(unified.manifestVersion === "1.29", "Unified manifest must use schema 1.29.");
assert(
    unified.$schema ===
        "https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json#",
    "Unified manifest schema URL does not match manifestVersion.",
);
assert(unified.developer?.name === "Vera", "Unified developer must be Vera.");
assert(
    unified.authorization?.permissions?.resourceSpecific?.some(
        (permission) =>
            permission.name === "Document.ReadWrite.User" &&
            permission.type === "Delegated",
    ),
    "Unified manifest must request delegated Document.ReadWrite.User.",
);

const extension = findOne(unified.extensions ?? [], () => true, "Office extension");
assert(
    extension.requirements?.scopes?.includes("document"),
    "Unified extension must target the document scope.",
);
assert(
    extension.requirements?.capabilities?.some(
        (capability) =>
            capability.name === "WordApi" && capability.minVersion === "1.3",
    ),
    "Unified extension must declare WordApi 1.3.",
);

const runtime = findOne(
    extension.runtimes ?? [],
    (candidate) =>
        candidate.code?.page === "https://localhost:3000/office/word",
    "Word taskpane runtime",
);
assert(
    runtime.requirements?.capabilities?.some(
        (capability) =>
            capability.name === "AddinCommands" &&
            capability.minVersion === "1.1",
    ),
    "Unified runtime must declare AddinCommands 1.1.",
);
const openAction = findOne(
    runtime.actions ?? [],
    (action) => action.type === "openPage",
    "openPage action",
);
const ribbonControls = (extension.ribbons ?? []).flatMap((ribbon) =>
    (ribbon.tabs ?? []).flatMap((tab) =>
        (tab.groups ?? []).flatMap((group) => group.controls ?? []),
    ),
);
assert(
    ribbonControls.some((control) => control.actionId === openAction.id),
    "Unified ribbon control must reference the taskpane action.",
);
assert(
    extension.alternates?.some(
        (alternate) => alternate.hide?.customOfficeAddin?.officeAddinId === xmlId,
    ),
    "Unified manifest must link the compatible XML add-in.",
);

const manifestUrls = [];
walk(unified, (key, value) => {
    if (
        typeof value === "string" &&
        (key.endsWith("Url") || key === "url" || key === "page")
    ) {
        manifestUrls.push(value);
    }
});
for (const value of manifestUrls) {
    const url = new URL(value);
    assert(url.protocol === "https:", `Manifest URL must use HTTPS: ${value}`);
}
assert(
    unified.validDomains?.includes("localhost:3000"),
    "Unified validDomains must contain the taskpane domain without a URL scheme.",
);

async function assertPng(relativePath, width, height) {
    const absolutePath = path.join(addinDir, relativePath);
    await access(absolutePath);
    const bytes = await readFile(absolutePath);
    assert(
        bytes.subarray(1, 4).toString("ascii") === "PNG",
        `${relativePath} must be a PNG file.`,
    );
    assert(
        bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height,
        `${relativePath} must be ${width}x${height}px.`,
    );
}

await Promise.all([
    assertPng(unified.icons.outline, 32, 32),
    assertPng(unified.icons.color, 192, 192),
]);

for (const [label, source, required] of [
    [
        "Office auth gate",
        `${gateSource}\n${dialogRuntimeSource}`,
        [
            "displayDialogAsync",
            "displayInIframe: false",
            "event.origin",
            "parseOfficeAuthDialogMessage",
            "supabase.auth",
            ".setSession",
        ],
    ],
    [
        "Office auth dialog",
        `${dialogSource}\n${dialogRuntimeSource}`,
        [
            "signInWithPassword",
            "getSession",
            "messageParent",
            "targetOrigin",
            "getAuthenticatorAssuranceLevel",
        ],
    ],
]) {
    for (const marker of required) {
        assert(source.includes(marker), `${label} is missing ${marker}.`);
    }
    assert(
        !/ALETHEIA_PRIVATE_AUTH_TOKEN|NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN/.test(
            source,
        ),
        `${label} must not use the local private-token boundary.`,
    );
}

console.log("Vera Word XML, unified manifest, icons, and Office auth boundary: OK");
