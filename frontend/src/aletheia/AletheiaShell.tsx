"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    ClipboardCheck,
    FileSearch,
    History,
    Library,
    Menu,
    Scale,
    Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AletheiaIcon } from "@/components/chat/aletheia-icon";

const navItems = [
    { href: "/aletheia", label: "Matters", icon: Scale },
    { href: "/aletheia/templates", label: "Templates", icon: Library },
    { href: "/aletheia/evidence", label: "Evidence", icon: FileSearch },
    { href: "/aletheia/reviews", label: "Reviews", icon: ClipboardCheck },
    { href: "/aletheia/agentops", label: "Command Center", icon: Workflow },
    { href: "/aletheia/audit", label: "Audit", icon: History },
];

export function AletheiaShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    return (
        <div className="flex h-dvh bg-[#f7f8f8] text-gray-950">
            <aside className="hidden w-64 shrink-0 flex-col border-r border-gray-200 bg-[#f4f5f5] md:flex">
                <div className="mb-2 flex items-center justify-between px-5 py-4">
                    <Link
                        href="/aletheia"
                        className="flex items-center gap-2 transition-opacity hover:opacity-80"
                    >
                        <AletheiaIcon size={28} />
                        <span className="font-serif text-2xl font-light leading-none">
                            Aletheia
                        </span>
                    </Link>
                </div>

                <div className="mx-3 mb-4 rounded-md border border-gray-200 bg-white px-3 py-2">
                    <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <span className="text-xs font-medium text-gray-900">
                            Local V1
                        </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-gray-500">
                        Private-pilot workspace
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
                                    "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors",
                                    isActive
                                        ? "bg-white text-gray-950 shadow-sm ring-1 ring-gray-200"
                                        : "text-gray-600 hover:bg-white hover:text-gray-950",
                                )}
                            >
                                <item.icon
                                    className={cn(
                                        "h-4 w-4",
                                        isActive ? "text-gray-950" : "text-gray-500",
                                    )}
                                />
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>

                <div className="mt-auto border-t border-gray-200 px-5 py-4">
                    <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-gray-400">
                        Verifiable workspace
                    </p>
                    <p className="mt-1 text-xs leading-5 text-gray-500">
                        Matter workflows, evidence, reviews, and audit records.
                    </p>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="border-b border-gray-200 bg-white md:hidden">
                    <div className="flex items-center gap-3 px-4 py-3">
                        <Menu className="h-5 w-5 text-gray-500" />
                        <Link
                            href="/aletheia"
                            className="flex items-center gap-2 transition-opacity hover:opacity-80"
                        >
                            <AletheiaIcon size={24} />
                            <span className="font-serif text-xl font-light">
                                Aletheia
                            </span>
                        </Link>
                        <span className="ml-auto rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
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
                                            ? "border-gray-300 bg-gray-950 text-white"
                                            : "border-gray-200 bg-white text-gray-600",
                                    )}
                                >
                                    <item.icon className="h-3.5 w-3.5" />
                                    {item.label}
                                </Link>
                            );
                        })}
                    </nav>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto bg-white">
                    {children}
                </main>
            </div>
        </div>
    );
}
