"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    Bell,
    Brain,
    CheckCircle2,
    Cpu,
    Database,
    Info,
    KeyRound,
    LockKeyhole,
    MessageCircle,
    Palette,
    PlugZap,
    RotateCw,
    Settings,
} from "lucide-react";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import {
    getApiKeyStatus,
    listMcpConnectors,
    refreshMcpConnectorTools,
    saveApiKey,
    updateMcpConnector,
    createMcpConnector,
    type ApiKeyProvider,
    type ApiKeyStatus,
    type McpConnectorSummary,
} from "@/app/lib/aletheiaApi";
import { cn } from "@/lib/utils";
import {
    DEFAULT_ALETHEIA_SETTINGS,
    applyAletheiaSettings,
    exportAletheiaSettings,
    normalizeAletheiaSettings,
    readAletheiaSettings,
    writeAletheiaSettings,
    type AletheiaClientSettings,
} from "./settingsModel";

type SettingsSectionId =
    | "model"
    | "chat"
    | "appearance"
    | "workspace"
    | "safety"
    | "context"
    | "providers"
    | "tools"
    | "mcp"
    | "gateway"
    | "notifications"
    | "about";

type SettingsSection = {
    id: SettingsSectionId;
    label: string;
    icon: typeof Cpu;
};

type LoadState<T> = {
    data: T | null;
    loading: boolean;
    error: string | null;
};

const settingsSections: SettingsSection[] = [
    { id: "model", label: "Model", icon: Cpu },
    { id: "chat", label: "Chat", icon: MessageCircle },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "workspace", label: "Workspace", icon: Database },
    { id: "safety", label: "Safety", icon: LockKeyhole },
    { id: "context", label: "Memory & Context", icon: Brain },
    { id: "providers", label: "Providers", icon: PlugZap },
    { id: "tools", label: "Tools & Keys", icon: KeyRound },
    { id: "mcp", label: "MCP", icon: PlugZap },
    { id: "gateway", label: "Gateway", icon: PlugZap },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "about", label: "About", icon: Info },
];

const providerRows: Array<{ provider: ApiKeyProvider; label: string }> = [
    { provider: "openai", label: "OpenAI" },
    { provider: "claude", label: "Anthropic" },
    { provider: "gemini", label: "Google Gemini" },
    { provider: "openrouter", label: "OpenRouter" },
    { provider: "courtlistener", label: "CourtListener" },
];

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

function SettingRow({
    label,
    detail,
    children,
}: {
    label: string;
    detail?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="grid gap-3 border-b border-gray-100 py-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_360px] md:items-center">
            <div className="min-w-0">
                <p className="text-sm font-medium text-gray-950">{label}</p>
                {detail ? (
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-500">
                        {detail}
                    </p>
                ) : null}
            </div>
            <div className="md:justify-self-end">{children}</div>
        </div>
    );
}

function Button({
    children,
    onClick,
    disabled,
    variant = "secondary",
}: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: "primary" | "secondary" | "danger";
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                variant === "primary" && "bg-gray-950 text-white hover:bg-gray-800",
                variant === "secondary" &&
                    "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                variant === "danger" &&
                    "border border-red-200 bg-white text-red-700 hover:bg-red-50",
            )}
        >
            {children}
        </button>
    );
}

function FieldSelect<T extends string>({
    value,
    onChange,
    options,
}: {
    value: T;
    onChange: (value: T) => void;
    options: readonly T[];
}) {
    return (
        <select
            value={value}
            onChange={(event) => onChange(event.target.value as T)}
            className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none transition-colors focus:border-gray-400 md:w-80"
        >
            {options.map((option) => (
                <option key={option} value={option}>
                    {option}
                </option>
            ))}
        </select>
    );
}

function Toggle({
    checked,
    onChange,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <button
            type="button"
            aria-pressed={checked}
            onClick={() => onChange(!checked)}
            className={cn(
                "relative h-6 w-10 rounded-full border transition-colors",
                checked
                    ? "border-gray-900 bg-gray-900"
                    : "border-gray-300 bg-gray-100",
            )}
        >
            <span
                className={cn(
                    "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
                    checked ? "translate-x-4" : "translate-x-0.5",
                )}
            />
        </button>
    );
}

function StatusPill({
    status,
    tone,
}: {
    status: string;
    tone: "ok" | "warn" | "muted" | "error";
}) {
    return (
        <span className="inline-flex items-center gap-2 text-sm text-gray-700">
            <span
                className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    tone === "ok" && "bg-emerald-500",
                    tone === "warn" && "bg-amber-500",
                    tone === "error" && "bg-red-500",
                    tone === "muted" && "bg-gray-300",
                )}
            />
            {status}
        </span>
    );
}

function SectionHeader({ title, detail }: { title: string; detail?: string }) {
    return (
        <div className="border-b border-gray-200 pb-4">
            <h1 className="text-xl font-semibold tracking-normal text-gray-950">
                {title}
            </h1>
            {detail ? (
                <p className="mt-1 text-sm leading-6 text-gray-500">{detail}</p>
            ) : null}
        </div>
    );
}

function sourceLabel(status: ApiKeyStatus | null, provider: ApiKeyProvider) {
    if (!status?.[provider]) return "Not configured";
    const source = status.sources?.[provider];
    return source === "env" ? "Configured by environment" : "Configured";
}

export function AletheiaSettings() {
    const importInputRef = useRef<HTMLInputElement>(null);
    const desktopBridge =
        typeof window !== "undefined" ? window.aletheiaDesktop : undefined;
    const [activeSection, setActiveSection] = useState<SettingsSectionId>("model");
    const [settings, setSettings] = useState<AletheiaClientSettings>(
        DEFAULT_ALETHEIA_SETTINGS,
    );
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [desktopInfo, setDesktopInfo] = useState<AletheiaDesktopInfo | null>(null);
    const [desktopAction, setDesktopAction] = useState<string | null>(null);
    const [providerDrafts, setProviderDrafts] = useState<Partial<Record<ApiKeyProvider, string>>>({});
    const [newMcpName, setNewMcpName] = useState("");
    const [newMcpUrl, setNewMcpUrl] = useState("");
    const [apiKeys, setApiKeys] = useState<LoadState<ApiKeyStatus>>({
        data: null,
        loading: true,
        error: null,
    });
    const [mcpConnectors, setMcpConnectors] = useState<LoadState<McpConnectorSummary[]>>({
        data: null,
        loading: true,
        error: null,
    });
    const [gatewayHealth, setGatewayHealth] = useState<LoadState<{ status?: string }>>({
        data: null,
        loading: true,
        error: null,
    });

    const modelOptions = useMemo(() => MODELS.map((model) => model.id), []);
    const auxiliaryModels = useMemo(
        () => [
            ["Vision", "Image analysis"],
            ["Web extract", "Page summarization"],
            ["Compression", "Context compaction"],
            ["Citation check", "Evidence validation"],
            ["Approval", "Gate classification"],
            ["MCP", "Tool routing"],
        ],
        [],
    );

    function updateSetting<K extends keyof AletheiaClientSettings>(
        key: K,
        value: AletheiaClientSettings[K],
    ) {
        setSettings((current) => {
            const next = normalizeAletheiaSettings({ ...current, [key]: value });
            writeAletheiaSettings(next);
            setSavedAt(new Date());
            return next;
        });
    }

    function replaceSettings(nextSettings: AletheiaClientSettings) {
        const normalized = normalizeAletheiaSettings(nextSettings);
        setSettings(normalized);
        writeAletheiaSettings(normalized);
        setSavedAt(new Date());
    }

    async function refreshRuntimeStatus() {
        setApiKeys((current) => ({ ...current, loading: true, error: null }));
        setMcpConnectors((current) => ({ ...current, loading: true, error: null }));
        setGatewayHealth((current) => ({ ...current, loading: true, error: null }));

        const [keysResult, connectorsResult, healthResult] = await Promise.allSettled([
            getApiKeyStatus(),
            listMcpConnectors(),
            fetch(`${apiBase}/health`, { cache: "no-store" }).then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return (await response.json()) as { status?: string };
            }),
        ]);

        setApiKeys({
            data: keysResult.status === "fulfilled" ? keysResult.value : null,
            loading: false,
            error: keysResult.status === "rejected" ? "Cannot reach provider settings API." : null,
        });
        setMcpConnectors({
            data: connectorsResult.status === "fulfilled" ? connectorsResult.value : null,
            loading: false,
            error: connectorsResult.status === "rejected" ? "Cannot load MCP connectors." : null,
        });
        setGatewayHealth({
            data: healthResult.status === "fulfilled" ? healthResult.value : null,
            loading: false,
            error: healthResult.status === "rejected" ? "Gateway is not reachable." : null,
        });
    }

    useEffect(() => {
        applyAletheiaSettings(settings);
    }, [settings]);

    useEffect(() => {
        const bridge =
            typeof window !== "undefined" ? window.aletheiaDesktop : undefined;
        void bridge?.getInfo().then(setDesktopInfo).catch(() => {
            setDesktopInfo(null);
        });
        const timer = window.setTimeout(() => {
            const stored = readAletheiaSettings();
            setSettings(stored);
            applyAletheiaSettings(stored);
            void refreshRuntimeStatus();
        }, 0);
        return () => window.clearTimeout(timer);
    }, []);

    async function handleSaveProviderKey(provider: ApiKeyProvider) {
        const value = providerDrafts[provider]?.trim();
        if (!value) return;
        const next = await saveApiKey(provider, value);
        setApiKeys({ data: next, loading: false, error: null });
        setProviderDrafts((current) => ({ ...current, [provider]: "" }));
    }

    async function handleClearProviderKey(provider: ApiKeyProvider) {
        const next = await saveApiKey(provider, null);
        setApiKeys({ data: next, loading: false, error: null });
        setProviderDrafts((current) => ({ ...current, [provider]: "" }));
    }

    async function handleMcpToggle(connector: McpConnectorSummary) {
        const updated = await updateMcpConnector(connector.id, {
            enabled: !connector.enabled,
        });
        setMcpConnectors((current) => ({
            data: (current.data ?? []).map((item) =>
                item.id === updated.id ? updated : item,
            ),
            loading: false,
            error: null,
        }));
    }

    async function handleMcpRefresh(connector: McpConnectorSummary) {
        const updated = await refreshMcpConnectorTools(connector.id);
        setMcpConnectors((current) => ({
            data: (current.data ?? []).map((item) =>
                item.id === updated.id ? updated : item,
            ),
            loading: false,
            error: null,
        }));
    }

    async function handleCreateMcpConnector() {
        if (!newMcpName.trim() || !newMcpUrl.trim()) return;
        const created = await createMcpConnector({
            name: newMcpName.trim(),
            serverUrl: newMcpUrl.trim(),
        });
        setMcpConnectors((current) => ({
            data: [created, ...(current.data ?? [])],
            loading: false,
            error: null,
        }));
        setNewMcpName("");
        setNewMcpUrl("");
    }

    async function handleImportSettings(file: File | null) {
        if (!file) return;
        const parsed = JSON.parse(await file.text()) as unknown;
        replaceSettings(normalizeAletheiaSettings(parsed));
    }

    async function runDesktopAction(label: string, action?: () => Promise<unknown>) {
        if (!action) return;
        setDesktopAction(`${label}...`);
        try {
            await action();
            setDesktopAction(`${label} complete`);
        } catch {
            setDesktopAction(`${label} failed`);
        }
    }

    function renderSection() {
        if (activeSection === "model") {
            return (
                <>
                    <SectionHeader
                        title="Model"
                        detail="Defaults are saved locally and shared with the chat model picker."
                    />
                    <SettingRow label="Provider">
                        <FieldSelect
                            value={settings.provider}
                            onChange={(value) => updateSetting("provider", value)}
                            options={["OpenAI", "Aletheia Gateway", "Local model"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Default model">
                        <FieldSelect
                            value={settings.defaultModel}
                            onChange={(value) => updateSetting("defaultModel", value)}
                            options={modelOptions}
                        />
                    </SettingRow>
                    <SettingRow label="Reasoning">
                        <FieldSelect
                            value={settings.reasoning}
                            onChange={(value) => updateSetting("reasoning", value)}
                            options={["Low", "Medium", "High"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Fast mode" detail="Prefer lower latency for routine drafting and navigation.">
                        <Toggle
                            checked={settings.fastMode}
                            onChange={(value) => updateSetting("fastMode", value)}
                        />
                    </SettingRow>
                    <div className="pt-5">
                        <div className="mb-2 flex items-center justify-between">
                            <h2 className="text-sm font-semibold text-gray-950">
                                Auxiliary models
                            </h2>
                            <Button
                                onClick={() =>
                                    updateSetting(
                                        "auxiliaryModels",
                                        DEFAULT_ALETHEIA_SETTINGS.auxiliaryModels,
                                    )
                                }
                            >
                                Reset to main
                            </Button>
                        </div>
                        <div className="divide-y divide-gray-100">
                            {auxiliaryModels.map(([name, role]) => (
                                <div
                                    key={name}
                                    className="grid gap-2 py-3 text-sm md:grid-cols-[minmax(0,1fr)_260px] md:items-center"
                                >
                                    <div>
                                        <span className="font-medium text-gray-950">
                                            {name}
                                        </span>
                                        <span className="ml-2 text-xs text-gray-400">
                                            {role}
                                        </span>
                                        <p className="mt-1 font-mono text-xs text-gray-500">
                                            {settings.auxiliaryModels[name] === "main"
                                                ? "auto · use main model"
                                                : settings.auxiliaryModels[name]}
                                        </p>
                                    </div>
                                    <FieldSelect
                                        value={settings.auxiliaryModels[name] ?? "main"}
                                        onChange={(value) =>
                                            updateSetting("auxiliaryModels", {
                                                ...settings.auxiliaryModels,
                                                [name]: value,
                                            })
                                        }
                                        options={["main", ...modelOptions]}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            );
        }

        if (activeSection === "workspace") {
            return (
                <>
                    <SectionHeader
                        title="Workspace"
                        detail="Local storage, matter defaults, and file export behavior."
                    />
                    <SettingRow label="Data directory">
                        <div className="flex items-center gap-2">
                            <code className="block min-w-0 flex-1 truncate rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                                {desktopInfo?.dataDir ?? "Desktop bridge unavailable"}
                            </code>
                            <Button
                                disabled={!desktopBridge}
                                onClick={() =>
                                    runDesktopAction(
                                        "Open data folder",
                                        desktopBridge?.openDataDirectory,
                                    )
                                }
                            >
                                Open
                            </Button>
                        </div>
                    </SettingRow>
                    <SettingRow label="Default matter template">
                        <FieldSelect
                            value={settings.defaultTemplate}
                            onChange={(value) => updateSetting("defaultTemplate", value)}
                            options={[
                                "Legal Matter Review",
                                "Compliance Impact Review",
                                "Deal Due Diligence",
                            ] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Evidence index">
                        <FieldSelect
                            value={settings.indexMode}
                            onChange={(value) => updateSetting("indexMode", value)}
                            options={["Keyword", "Semantic", "Disabled"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Demo records" detail="Controls whether fallback demo matters are mixed into the local matter list.">
                        <Toggle
                            checked={settings.demoDataEnabled}
                            onChange={(value) => updateSetting("demoDataEnabled", value)}
                        />
                    </SettingRow>
                </>
            );
        }

        if (activeSection === "chat") {
            return (
                <>
                    <SectionHeader
                        title="Chat"
                        detail="Composer behavior for local matter sessions."
                    />
                    <SettingRow label="Default landing">
                        <FieldSelect
                            value={settings.defaultLanding}
                            onChange={(value) => updateSetting("defaultLanding", value)}
                            options={["Matters", "Agent Console", "Last opened matter"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Open command bar with new matters">
                        <Toggle
                            checked={settings.openCommandBarWithNewMatters}
                            onChange={(value) => updateSetting("openCommandBarWithNewMatters", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Show citations inline">
                        <Toggle
                            checked={settings.showCitationsInline}
                            onChange={(value) => updateSetting("showCitationsInline", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Draft autosave">
                        <FieldSelect
                            value={settings.draftAutosave}
                            onChange={(value) => updateSetting("draftAutosave", value)}
                            options={["On", "Off"] as const}
                        />
                    </SettingRow>
                </>
            );
        }

        if (activeSection === "appearance") {
            return (
                <>
                    <SectionHeader
                        title="Appearance"
                        detail="These preferences are applied to the local client document root immediately."
                    />
                    <SettingRow label="Theme">
                        <FieldSelect
                            value={settings.theme}
                            onChange={(value) => updateSetting("theme", value)}
                            options={["System", "Light", "Dark"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Density">
                        <FieldSelect
                            value={settings.density}
                            onChange={(value) => updateSetting("density", value)}
                            options={["Comfortable", "Compact"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Sidebar">
                        <FieldSelect
                            value={settings.sidebar}
                            onChange={(value) => updateSetting("sidebar", value)}
                            options={["Standard", "Narrow"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Document font size">
                        <FieldSelect
                            value={settings.documentFontSize}
                            onChange={(value) => updateSetting("documentFontSize", value)}
                            options={["Small", "Medium", "Large"] as const}
                        />
                    </SettingRow>
                </>
            );
        }

        if (activeSection === "safety") {
            return (
                <>
                    <SectionHeader
                        title="Safety"
                        detail="Approval and export gates for high-risk legal work."
                    />
                    <SettingRow label="Human approval for high-risk matters">
                        <Toggle
                            checked={settings.approvalRequired}
                            onChange={(value) => updateSetting("approvalRequired", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Citation gate before memo export">
                        <Toggle
                            checked={settings.citationGate}
                            onChange={(value) => updateSetting("citationGate", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Final export policy">
                        <FieldSelect
                            value={settings.finalExportPolicy}
                            onChange={(value) => updateSetting("finalExportPolicy", value)}
                            options={["Fail closed", "Warn only"] as const}
                        />
                    </SettingRow>
                    <SettingRow label="Audit retention">
                        <FieldSelect
                            value={settings.auditRetention}
                            onChange={(value) => updateSetting("auditRetention", value)}
                            options={["Keep indefinitely", "One year", "Ninety days"] as const}
                        />
                    </SettingRow>
                </>
            );
        }

        if (activeSection === "context") {
            return (
                <>
                    <SectionHeader
                        title="Memory & Context"
                        detail="Matter memory, compression, and audit context settings."
                    />
                    <SettingRow label="Matter memory">
                        <Toggle
                            checked={settings.matterMemory}
                            onChange={(value) => updateSetting("matterMemory", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Include audit events in context">
                        <Toggle
                            checked={settings.auditContext}
                            onChange={(value) => updateSetting("auditContext", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Context compression">
                        <FieldSelect
                            value={settings.contextCompression}
                            onChange={(value) => updateSetting("contextCompression", value)}
                            options={["Auto", "Manual", "Off"] as const}
                        />
                    </SettingRow>
                </>
            );
        }

        if (activeSection === "tools") {
            return (
                <>
                    <SectionHeader
                        title="Tools & Keys"
                        detail="Configuration import/export and desktop file-system actions."
                    />
                    <SettingRow label="Settings file">
                        <div className="flex justify-end gap-2">
                            <Button onClick={() => exportAletheiaSettings(settings)}>
                                Export
                            </Button>
                            <Button onClick={() => importInputRef.current?.click()}>
                                Import
                            </Button>
                            <input
                                ref={importInputRef}
                                type="file"
                                accept="application/json"
                                className="hidden"
                                onChange={(event) => {
                                    void handleImportSettings(event.target.files?.[0] ?? null);
                                    event.target.value = "";
                                }}
                            />
                        </div>
                    </SettingRow>
                    <SettingRow label="Reset preferences">
                        <Button
                            variant="danger"
                            onClick={() => replaceSettings(DEFAULT_ALETHEIA_SETTINGS)}
                        >
                            Reset
                        </Button>
                    </SettingRow>
                    <SettingRow label="Logs">
                        <div className="flex items-center gap-2">
                            <code className="block min-w-0 flex-1 truncate rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                                {desktopInfo?.logsDir ?? "Desktop bridge unavailable"}
                            </code>
                            <Button
                                disabled={!desktopBridge}
                                onClick={() =>
                                    runDesktopAction(
                                        "Open logs folder",
                                        desktopBridge?.openLogsDirectory,
                                    )
                                }
                            >
                                Open
                            </Button>
                        </div>
                    </SettingRow>
                </>
            );
        }

        if (activeSection === "providers") {
            return (
                <>
                    <SectionHeader
                        title="Providers"
                        detail="API key status is loaded from the local backend. Saving a key writes through the backend vault."
                    />
                    {apiKeys.error ? (
                        <p className="border-b border-gray-100 py-4 text-sm text-red-600">
                            {apiKeys.error}
                        </p>
                    ) : null}
                    {providerRows.map((row) => (
                        <SettingRow key={row.provider} label={row.label}>
                            <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
                                <input
                                    value={providerDrafts[row.provider] ?? ""}
                                    onChange={(event) =>
                                        setProviderDrafts((current) => ({
                                            ...current,
                                            [row.provider]: event.target.value,
                                        }))
                                    }
                                    type="password"
                                    placeholder={sourceLabel(apiKeys.data, row.provider)}
                                    className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400"
                                />
                                <Button
                                    disabled={!providerDrafts[row.provider]?.trim()}
                                    onClick={() => void handleSaveProviderKey(row.provider)}
                                >
                                    Save
                                </Button>
                                <Button onClick={() => void handleClearProviderKey(row.provider)}>
                                    Clear
                                </Button>
                            </div>
                        </SettingRow>
                    ))}
                </>
            );
        }

        if (activeSection === "mcp") {
            return (
                <>
                    <SectionHeader
                        title="MCP"
                        detail="Connectors are read from and written to the local MCP backend."
                    />
                    <SettingRow label="Add connector">
                        <div className="grid gap-2">
                            <input
                                value={newMcpName}
                                onChange={(event) => setNewMcpName(event.target.value)}
                                placeholder="Connector name"
                                className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400"
                            />
                            <input
                                value={newMcpUrl}
                                onChange={(event) => setNewMcpUrl(event.target.value)}
                                placeholder="https://mcp.example.com/mcp"
                                className="h-9 rounded-md border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400"
                            />
                            <Button
                                disabled={!newMcpName.trim() || !newMcpUrl.trim()}
                                onClick={() => void handleCreateMcpConnector()}
                            >
                                Add
                            </Button>
                        </div>
                    </SettingRow>
                    {mcpConnectors.error ? (
                        <p className="border-b border-gray-100 py-4 text-sm text-red-600">
                            {mcpConnectors.error}
                        </p>
                    ) : null}
                    {(mcpConnectors.data ?? []).map((connector) => (
                        <SettingRow
                            key={connector.id}
                            label={connector.name}
                            detail={`${connector.serverUrl} · ${connector.toolCount} tools`}
                        >
                            <div className="flex justify-end gap-2">
                                <Toggle
                                    checked={connector.enabled}
                                    onChange={() => void handleMcpToggle(connector)}
                                />
                                <Button onClick={() => void handleMcpRefresh(connector)}>
                                    Refresh
                                </Button>
                            </div>
                        </SettingRow>
                    ))}
                    {!mcpConnectors.loading && (mcpConnectors.data ?? []).length === 0 ? (
                        <p className="py-5 text-sm text-gray-500">No MCP connectors configured.</p>
                    ) : null}
                </>
            );
        }

        if (activeSection === "gateway") {
            const gatewayOk = Boolean(gatewayHealth.data && !gatewayHealth.error);
            return (
                <>
                    <SectionHeader
                        title="Gateway"
                        detail="Runtime status is probed from the local backend and desktop bridge."
                    />
                    <SettingRow label="Backend">
                        <StatusPill
                            tone={gatewayOk ? "ok" : gatewayHealth.loading ? "muted" : "error"}
                            status={
                                gatewayHealth.loading
                                    ? "Checking"
                                    : gatewayOk
                                      ? gatewayHealth.data?.status ?? "Ready"
                                      : "Unavailable"
                            }
                        />
                    </SettingRow>
                    <SettingRow label="Storage">
                        <StatusPill
                            tone={desktopInfo ? "ok" : "warn"}
                            status={desktopInfo ? "Local desktop data directory" : "Web fallback"}
                        />
                    </SettingRow>
                    <SettingRow label="Retrieval">
                        <StatusPill
                            tone={settings.indexMode === "Disabled" ? "muted" : "ok"}
                            status={settings.indexMode}
                        />
                    </SettingRow>
                    <SettingRow label="Refresh status">
                        <Button onClick={() => void refreshRuntimeStatus()}>
                            <RotateCw className="mr-2 h-3.5 w-3.5" />
                            Refresh
                        </Button>
                    </SettingRow>
                    <SettingRow label="Local services">
                        <Button
                            disabled={!desktopBridge}
                            onClick={() =>
                                runDesktopAction(
                                    "Restart local services",
                                    desktopBridge?.restartLocalServices,
                                )
                            }
                        >
                            Restart
                        </Button>
                    </SettingRow>
                </>
            );
        }

        if (activeSection === "notifications") {
            return (
                <>
                    <SectionHeader
                        title="Notifications"
                        detail="Local reminders for approvals, exports, and indexing."
                    />
                    <SettingRow label="Approval requests">
                        <Toggle
                            checked={settings.approvalNotification}
                            onChange={(value) => updateSetting("approvalNotification", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Export completion">
                        <Toggle
                            checked={settings.exportNotification}
                            onChange={(value) => updateSetting("exportNotification", value)}
                        />
                    </SettingRow>
                    <SettingRow label="Indexing finished">
                        <Toggle
                            checked={settings.indexingNotification}
                            onChange={(value) => updateSetting("indexingNotification", value)}
                        />
                    </SettingRow>
                </>
            );
        }

        return (
            <>
                <SectionHeader title="About" detail="Version and local runtime details." />
                <SettingRow label="Version">
                    <span className="text-sm text-gray-700">
                        {desktopInfo?.appVersion ?? "web preview"}
                    </span>
                </SettingRow>
                <SettingRow label="Backend URL">
                    <span className="font-mono text-xs text-gray-500">
                        {desktopInfo?.backendUrl ?? apiBase}
                    </span>
                </SettingRow>
                <SettingRow label="Settings state">
                    <span className="inline-flex items-center gap-2 text-sm text-gray-700">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        {savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : "Loaded"}
                    </span>
                </SettingRow>
            </>
        );
    }

    return (
        <section className="flex min-h-full flex-col bg-[#fbfbfc]">
            <div className="border-b border-gray-200 bg-white px-5 py-4 md:px-8">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2">
                            <Settings className="h-4 w-4 text-gray-500" />
                            <h1 className="text-[22px] font-semibold leading-7 text-gray-950">
                                Settings
                            </h1>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                            {savedAt
                                ? `Saved ${savedAt.toLocaleTimeString()}`
                                : "Local client preferences"}
                        </p>
                    </div>
                    {desktopAction ? (
                        <span className="text-xs font-medium text-gray-500">
                            {desktopAction}
                        </span>
                    ) : null}
                </div>
            </div>

            <div className="grid min-h-0 flex-1 md:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="border-b border-gray-200 bg-[#f7f7f8] p-3 md:border-b-0 md:border-r">
                    <nav className="grid gap-1">
                        {settingsSections.map((section) => {
                            const Icon = section.icon;
                            const active = activeSection === section.id;
                            return (
                                <button
                                    key={section.id}
                                    type="button"
                                    onClick={() => setActiveSection(section.id)}
                                    className={cn(
                                        "flex h-9 items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium transition-colors",
                                        active
                                            ? "border border-gray-200 bg-white text-gray-950"
                                            : "text-gray-600 hover:bg-white hover:text-gray-950",
                                    )}
                                >
                                    <Icon
                                        className={cn(
                                            "h-4 w-4 stroke-[1.8]",
                                            active ? "text-gray-950" : "text-gray-500",
                                        )}
                                    />
                                    {section.label}
                                </button>
                            );
                        })}
                    </nav>
                </aside>

                <main className="min-w-0 overflow-y-auto">
                    <div className="mx-auto max-w-5xl px-5 py-7 md:px-8">
                        {renderSection()}
                    </div>
                </main>
            </div>
        </section>
    );
}
