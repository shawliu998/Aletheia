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
    { href: "/aletheia/matters", label: "Matters", icon: Scale },
    { href: "/aletheia/templates", label: "Templates", icon: Library },
    { href: "/aletheia/evidence", label: "Evidence", icon: FileSearch },
    { href: "/aletheia/reviews", label: "Reviews", icon: ClipboardCheck },
    { href: "/aletheia/agentops", label: "Command Center", icon: Workflow },
    { href: "/aletheia/audit", label: "Audit", icon: History },
];

export function AletheiaShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();

    return (
        <div className="flex h-dvh bg-[#eef1f5] text-gray-950">
            <aside className="hidden w-64 shrink-0 flex-col border-r border-white/70 bg-[#f4f6f8]/82 shadow-[inset_-1px_0_0_rgba(255,255,255,0.68)] backdrop-blur-2xl md:flex">
                <div className="mb-1 flex items-center justify-between px-4 py-4">
                    <Link
                        href="/aletheia"
                        className="flex items-center gap-2 transition-opacity hover:opacity-80"
                    >
                        <AletheiaIcon size={28} />
                        <span className="font-serif text-2xl font-light leading-none text-gray-950">
                            Aletheia
                        </span>
                    </Link>
                </div>

                <div className="mx-3 mb-3 border-b border-white/70 px-2 pb-3">
                    <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <span className="text-xs font-semibold text-gray-900">
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
                                    "flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] font-semibold transition-colors",
                                    isActive
                                        ? "bg-white/72 text-gray-950 shadow-[0_3px_10px_rgba(15,23,42,0.05)] ring-1 ring-white/80"
                                        : "text-gray-600 hover:bg-white/44 hover:text-gray-950",
                                )}
                            >
                                <item.icon
                                    className={cn(
                                        "h-[15px] w-[15px] stroke-[1.8]",
                                        isActive ? "text-gray-950" : "text-gray-500",
                                    )}
                                />
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>

                <div className="mt-auto border-t border-white/70 px-5 py-4">
                    <Link
                        href="/aletheia/matters"
                        className="text-sm font-semibold text-gray-500 transition-colors hover:text-gray-950"
                    >
                        Product demo
                    </Link>
                    <p className="mt-2 text-xs leading-5 text-gray-500">
                        Local matter workspace
                    </p>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="border-b border-white/70 bg-white/72 backdrop-blur-2xl md:hidden">
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
                        <span className="ml-auto rounded-full border border-emerald-200/70 bg-emerald-50/80 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
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
                                        "flex h-8 shrink-0 items-center gap-2 rounded-full border px-2.5 text-xs font-semibold",
                                        isActive
                                            ? "border-gray-950 bg-gray-950 text-white"
                                            : "border-white/70 bg-white/60 text-gray-600",
                                    )}
                                >
                                    <item.icon className="h-3.5 w-3.5" />
                                    {item.label}
                                </Link>
                            );
                        })}
                    </nav>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto bg-[#fbfbfc]">
                    {children}
                </main>
            </div>
        </div>
    );
}
