"use client";

import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from "@/app/components/assistant/ModelToggle";

export const ALETHEIA_SETTINGS_KEY = "aletheia.clientSettings.v1";
export const SELECTED_MODEL_KEY = "aletheia.selectedModel";
export const ALETHEIA_SETTINGS_EVENT = "aletheia-settings-change";

export type AletheiaProvider = "OpenAI" | "Aletheia Gateway" | "Local model";
export type AletheiaReasoning = "Low" | "Medium" | "High";
export type AletheiaTheme = "System" | "Light" | "Dark";
export type AletheiaDensity = "Comfortable" | "Compact";
export type AletheiaSidebarMode = "Standard" | "Narrow";
export type AletheiaLanding = "Matters" | "Agent Console" | "Last opened matter";
export type AletheiaIndexMode = "Keyword" | "Semantic" | "Disabled";
export type AletheiaAutosave = "On" | "Off";
export type AletheiaFinalExportPolicy = "Fail closed" | "Warn only";
export type AletheiaAuditRetention = "Keep indefinitely" | "One year" | "Ninety days";
export type AletheiaCompression = "Auto" | "Manual" | "Off";
export type AletheiaMatterTemplate =
    | "Legal Matter Review"
    | "Compliance Impact Review"
    | "Deal Due Diligence";

export interface AletheiaClientSettings {
    provider: AletheiaProvider;
    defaultModel: string;
    reasoning: AletheiaReasoning;
    fastMode: boolean;
    theme: AletheiaTheme;
    density: AletheiaDensity;
    sidebar: AletheiaSidebarMode;
    documentFontSize: "Small" | "Medium" | "Large";
    defaultTemplate: AletheiaMatterTemplate;
    indexMode: AletheiaIndexMode;
    demoDataEnabled: boolean;
    defaultLanding: AletheiaLanding;
    openCommandBarWithNewMatters: boolean;
    showCitationsInline: boolean;
    draftAutosave: AletheiaAutosave;
    approvalRequired: boolean;
    citationGate: boolean;
    finalExportPolicy: AletheiaFinalExportPolicy;
    auditRetention: AletheiaAuditRetention;
    matterMemory: boolean;
    auditContext: boolean;
    contextCompression: AletheiaCompression;
    approvalNotification: boolean;
    exportNotification: boolean;
    indexingNotification: boolean;
    auxiliaryModels: Record<string, string>;
}

export const DEFAULT_ALETHEIA_SETTINGS: AletheiaClientSettings = {
    provider: "OpenAI",
    defaultModel: DEFAULT_MODEL_ID,
    reasoning: "Medium",
    fastMode: false,
    theme: "System",
    density: "Comfortable",
    sidebar: "Standard",
    documentFontSize: "Medium",
    defaultTemplate: "Legal Matter Review",
    indexMode: "Keyword",
    demoDataEnabled: true,
    defaultLanding: "Matters",
    openCommandBarWithNewMatters: true,
    showCitationsInline: true,
    draftAutosave: "On",
    approvalRequired: true,
    citationGate: true,
    finalExportPolicy: "Fail closed",
    auditRetention: "Keep indefinitely",
    matterMemory: true,
    auditContext: true,
    contextCompression: "Auto",
    approvalNotification: true,
    exportNotification: true,
    indexingNotification: true,
    auxiliaryModels: {
        Vision: "main",
        "Web extract": "main",
        Compression: "main",
        "Citation check": "main",
        Approval: "main",
        MCP: "main",
    },
};

function asString(value: unknown, fallback: string) {
    return typeof value === "string" && value.trim() ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean) {
    return typeof value === "boolean" ? value : fallback;
}

function member<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
    return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeAletheiaSettings(value: unknown): AletheiaClientSettings {
    const raw =
        value && typeof value === "object"
            ? (value as Partial<AletheiaClientSettings>)
            : {};
    const defaultModel = asString(raw.defaultModel, DEFAULT_ALETHEIA_SETTINGS.defaultModel);

    return {
        provider: member(raw.provider, ["OpenAI", "Aletheia Gateway", "Local model"], DEFAULT_ALETHEIA_SETTINGS.provider),
        defaultModel: ALLOWED_MODEL_IDS.has(defaultModel) ? defaultModel : DEFAULT_ALETHEIA_SETTINGS.defaultModel,
        reasoning: member(raw.reasoning, ["Low", "Medium", "High"], DEFAULT_ALETHEIA_SETTINGS.reasoning),
        fastMode: asBoolean(raw.fastMode, DEFAULT_ALETHEIA_SETTINGS.fastMode),
        theme: member(raw.theme, ["System", "Light", "Dark"], DEFAULT_ALETHEIA_SETTINGS.theme),
        density: member(raw.density, ["Comfortable", "Compact"], DEFAULT_ALETHEIA_SETTINGS.density),
        sidebar: member(raw.sidebar, ["Standard", "Narrow"], DEFAULT_ALETHEIA_SETTINGS.sidebar),
        documentFontSize: member(raw.documentFontSize, ["Small", "Medium", "Large"], DEFAULT_ALETHEIA_SETTINGS.documentFontSize),
        defaultTemplate: member(raw.defaultTemplate, ["Legal Matter Review", "Compliance Impact Review", "Deal Due Diligence"], DEFAULT_ALETHEIA_SETTINGS.defaultTemplate),
        indexMode: member(raw.indexMode, ["Keyword", "Semantic", "Disabled"], DEFAULT_ALETHEIA_SETTINGS.indexMode),
        demoDataEnabled: asBoolean(raw.demoDataEnabled, DEFAULT_ALETHEIA_SETTINGS.demoDataEnabled),
        defaultLanding: member(raw.defaultLanding, ["Matters", "Agent Console", "Last opened matter"], DEFAULT_ALETHEIA_SETTINGS.defaultLanding),
        openCommandBarWithNewMatters: asBoolean(raw.openCommandBarWithNewMatters, DEFAULT_ALETHEIA_SETTINGS.openCommandBarWithNewMatters),
        showCitationsInline: asBoolean(raw.showCitationsInline, DEFAULT_ALETHEIA_SETTINGS.showCitationsInline),
        draftAutosave: member(raw.draftAutosave, ["On", "Off"], DEFAULT_ALETHEIA_SETTINGS.draftAutosave),
        approvalRequired: asBoolean(raw.approvalRequired, DEFAULT_ALETHEIA_SETTINGS.approvalRequired),
        citationGate: asBoolean(raw.citationGate, DEFAULT_ALETHEIA_SETTINGS.citationGate),
        finalExportPolicy: member(raw.finalExportPolicy, ["Fail closed", "Warn only"], DEFAULT_ALETHEIA_SETTINGS.finalExportPolicy),
        auditRetention: member(raw.auditRetention, ["Keep indefinitely", "One year", "Ninety days"], DEFAULT_ALETHEIA_SETTINGS.auditRetention),
        matterMemory: asBoolean(raw.matterMemory, DEFAULT_ALETHEIA_SETTINGS.matterMemory),
        auditContext: asBoolean(raw.auditContext, DEFAULT_ALETHEIA_SETTINGS.auditContext),
        contextCompression: member(raw.contextCompression, ["Auto", "Manual", "Off"], DEFAULT_ALETHEIA_SETTINGS.contextCompression),
        approvalNotification: asBoolean(raw.approvalNotification, DEFAULT_ALETHEIA_SETTINGS.approvalNotification),
        exportNotification: asBoolean(raw.exportNotification, DEFAULT_ALETHEIA_SETTINGS.exportNotification),
        indexingNotification: asBoolean(raw.indexingNotification, DEFAULT_ALETHEIA_SETTINGS.indexingNotification),
        auxiliaryModels: {
            ...DEFAULT_ALETHEIA_SETTINGS.auxiliaryModels,
            ...(raw.auxiliaryModels && typeof raw.auxiliaryModels === "object"
                ? raw.auxiliaryModels
                : {}),
        },
    };
}

export function readAletheiaSettings(): AletheiaClientSettings {
    if (typeof window === "undefined") return DEFAULT_ALETHEIA_SETTINGS;
    try {
        const raw = window.localStorage.getItem(ALETHEIA_SETTINGS_KEY);
        return normalizeAletheiaSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return DEFAULT_ALETHEIA_SETTINGS;
    }
}

export function applyAletheiaSettings(settings: AletheiaClientSettings) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.aletheiaTheme = settings.theme.toLowerCase();
    root.dataset.aletheiaDensity = settings.density.toLowerCase();
    root.dataset.aletheiaSidebar = settings.sidebar.toLowerCase();
    root.dataset.aletheiaDocumentFontSize = settings.documentFontSize.toLowerCase();
}

export function writeAletheiaSettings(settings: AletheiaClientSettings) {
    if (typeof window === "undefined") return;
    const next = normalizeAletheiaSettings(settings);
    window.localStorage.setItem(ALETHEIA_SETTINGS_KEY, JSON.stringify(next));
    window.localStorage.setItem(SELECTED_MODEL_KEY, next.defaultModel);
    applyAletheiaSettings(next);
    window.dispatchEvent(new CustomEvent(ALETHEIA_SETTINGS_EVENT, { detail: next }));
}

export function exportAletheiaSettings(settings: AletheiaClientSettings) {
    const blob = new Blob([JSON.stringify(normalizeAletheiaSettings(settings), null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "aletheia-settings.json";
    anchor.click();
    URL.revokeObjectURL(url);
}
