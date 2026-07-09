"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    ClipboardCheck,
    FileSearch,
    History,
    Library,
    Menu,
    Scale,
    Settings,
    Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AletheiaIcon } from "@/components/chat/aletheia-icon";
import {
    ALETHEIA_SETTINGS_EVENT,
    applyAletheiaSettings,
    readAletheiaSettings,
} from "./settingsModel";

const navItems = [
    { href: "/aletheia/matters", label: "Matters", icon: Scale },
    { href: "/aletheia/templates", label: "Templates", icon: Library },
    { href: "/workflows", label: "Workflows", icon: Workflow },
    { href: "/aletheia/evidence", label: "Evidence", icon: FileSearch },
    { href: "/aletheia/reviews", label: "Reviews", icon: ClipboardCheck },
    { href: "/aletheia/agentops", label: "Command Center", icon: Workflow },
    { href: "/aletheia/audit", label: "Audit", icon: History },
];

export function AletheiaShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const isLocalClient = process.env.NEXT_PUBLIC_ALETHEIA_LOCAL_CLIENT === "true";
    const [sidebarMode, setSidebarMode] = useState<"Standard" | "Narrow">("Standard");
    const [density, setDensity] = useState<"Comfortable" | "Compact">("Comfortable");

    useEffect(() => {
        function syncSettings() {
            const settings = readAletheiaSettings();
            applyAletheiaSettings(settings);
            setSidebarMode(settings.sidebar);
            setDensity(settings.density);
        }
        syncSettings();
        window.addEventListener(ALETHEIA_SETTINGS_EVENT, syncSettings);
        return () => {
            window.removeEventListener(ALETHEIA_SETTINGS_EVENT, syncSettings);
        };
    }, []);

    const narrowSidebar = sidebarMode === "Narrow";
    const navHeight = density === "Compact" ? "h-8" : "h-9";

    return (
        <div className="flex h-dvh bg-[#f4f5f6] text-gray-950">
            <aside
                className={cn(
                    "hidden shrink-0 flex-col border-r border-gray-200 bg-[#f7f7f8] md:flex",
                    narrowSidebar ? "w-[76px]" : "w-64",
                )}
            >
                <div
                    className={cn(
                        "mb-1 flex items-center justify-between px-4 py-4",
                        isLocalClient && !narrowSidebar && "pl-[112px]",
                        narrowSidebar && "justify-center px-2",
                        isLocalClient && narrowSidebar && "pt-14",
                    )}
                >
                    <Link
                        href="/aletheia/matters"
                        className="flex items-center gap-2 transition-opacity hover:opacity-80"
                    >
                        <AletheiaIcon size={isLocalClient ? 30 : 24} />
                        <span
                            className={cn(
                                "font-serif text-[23px] font-light leading-none text-gray-950",
                                narrowSidebar && "sr-only",
                            )}
                        >
                            Aletheia
                        </span>
                    </Link>
                </div>

                <div
                    className={cn(
                        "mx-3 mb-3 border-b border-gray-200 px-2 pb-3",
                        narrowSidebar && "sr-only",
                    )}
                >
                    <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <span className="text-xs font-medium text-gray-900">
                            Local V1
                        </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-gray-500">
                        Local workspace
                    </p>
                </div>

                <nav className="space-y-0.5 px-2.5">
                    {navItems.map((item) => {
                        const isActive =
                            pathname === item.href ||
                            (item.href !== "/aletheia" &&
                                pathname.startsWith(`${item.href}/`));
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={cn(
                                    "flex items-center gap-3 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                                    navHeight,
                                    narrowSidebar && "justify-center px-0",
                                    isActive
                                        ? "border border-gray-200 bg-white text-gray-950"
                                        : "text-gray-600 hover:bg-white hover:text-gray-950",
                                )}
                            >
                                <item.icon
                                    className={cn(
                                        "h-[15px] w-[15px] stroke-[1.8]",
                                        isActive ? "text-gray-950" : "text-gray-500",
                                    )}
                                />
                                <span className={cn(narrowSidebar && "sr-only")}>
                                    {item.label}
                                </span>
                            </Link>
                        );
                    })}
                </nav>

                <div className="mt-auto border-t border-gray-200 px-2.5 py-3">
                    <Link
                        href="/aletheia/settings"
                        className={cn(
                            "flex items-center gap-3 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                            navHeight,
                            narrowSidebar && "justify-center px-0",
                            pathname === "/aletheia/settings"
                                ? "border border-gray-200 bg-white text-gray-950"
                                : "text-gray-600 hover:bg-white hover:text-gray-950",
                        )}
                    >
                        <Settings
                            className={cn(
                                "h-[15px] w-[15px] stroke-[1.8]",
                                pathname === "/aletheia/settings"
                                    ? "text-gray-950"
                                    : "text-gray-500",
                            )}
                        />
                        <span className={cn(narrowSidebar && "sr-only")}>Settings</span>
                    </Link>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="border-b border-gray-200 bg-white md:hidden">
                    <div className="flex items-center gap-3 px-4 py-3">
                        <Menu className="h-5 w-5 text-gray-500" />
                        <Link
                            href="/aletheia/matters"
                            className="flex items-center gap-2 transition-opacity hover:opacity-80"
                        >
                            <AletheiaIcon size={24} />
                            <span className="font-serif text-xl font-light">
                                Aletheia
                            </span>
                        </Link>
                        <span className="ml-auto text-[11px] font-medium text-emerald-700">
                            Local V1
                        </span>
                    </div>
                    <nav className="flex gap-1 overflow-x-auto px-3 pb-3">
                        {navItems.map((item) => {
                            const isActive =
                                pathname === item.href ||
                                (item.href !== "/aletheia" &&
                                    pathname.startsWith(`${item.href}/`));
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={cn(
                                        "flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 text-xs font-medium",
                                        isActive
                                            ? "border-gray-950 bg-gray-950 text-white"
                                            : "border-gray-200 bg-white text-gray-600",
                                    )}
                                >
                                    <item.icon className="h-3.5 w-3.5" />
                                    {item.label}
                                </Link>
                            );
                        })}
                        <Link
                            href="/aletheia/settings"
                            className={cn(
                                "flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 text-xs font-medium",
                                pathname === "/aletheia/settings"
                                    ? "border-gray-950 bg-gray-950 text-white"
                                    : "border-gray-200 bg-white text-gray-600",
                            )}
                        >
                            <Settings className="h-3.5 w-3.5" />
                            Settings
                        </Link>
                    </nav>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto bg-[#fbfbfc]">
                    {children}
                </main>
            </div>
        </div>
    );
}
