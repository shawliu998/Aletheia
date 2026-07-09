import Link from "next/link";
import { AletheiaIcon } from "@/components/chat/aletheia-icon";

const proofItems = ["Matters", "Evidence", "Reviews", "Audit"];

export default function AletheiaHome() {
    return (
        <main className="min-h-dvh overflow-hidden bg-[linear-gradient(180deg,#d7edff_0%,#edf8ff_52%,#ffffff_88%)] text-[#111827]">
            <header className="fixed inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
                <Link
                    href="/aletheia"
                    className="inline-flex h-11 items-center gap-2 rounded-full border border-white/55 bg-white/26 px-3.5 text-[#111827] shadow-[0_12px_28px_rgba(17,24,39,0.08),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl transition-colors hover:bg-white/38"
                >
                    <AletheiaIcon size={24} />
                    <span className="font-serif text-[1.55rem] font-medium leading-none tracking-normal">
                        Aletheia
                    </span>
                </Link>

                <nav
                    aria-label="Primary"
                    className="inline-flex h-11 items-center gap-1 rounded-full border border-white/55 bg-white/28 p-1 shadow-[0_12px_28px_rgba(17,24,39,0.08),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-xl"
                >
                    <Link
                        href="/aletheia/templates"
                        className="hidden h-9 items-center rounded-full px-4 text-[0.95rem] font-semibold text-[#1f2937] transition-colors hover:bg-white/42 sm:inline-flex"
                    >
                        Workflows
                    </Link>
                    <Link
                        href="/aletheia/docs"
                        className="hidden h-9 items-center rounded-full px-4 text-[0.95rem] font-semibold text-[#1f2937] transition-colors hover:bg-white/42 sm:inline-flex"
                    >
                        Docs
                    </Link>
                    <Link
                        href="/aletheia/matters"
                        className="inline-flex h-9 items-center rounded-full bg-[#111827] px-4 text-[0.95rem] font-semibold text-white shadow-[0_2px_6px_rgba(17,24,39,0.18)] transition-colors hover:bg-[#1f2937]"
                    >
                        Open
                    </Link>
                </nav>
            </header>

            <section className="relative flex min-h-dvh flex-col items-center px-5 pt-28 text-center sm:pt-36">
                <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col items-center pt-32 sm:pt-28 lg:pt-24">
                    <h1 className="max-w-[1500px] font-serif text-5xl font-medium leading-[0.98] tracking-normal text-[#111827] sm:text-6xl md:text-7xl lg:text-[4.8rem] xl:text-[5rem]">
                        Aletheia, a local legal workspace.
                    </h1>
                    <p className="mt-7 max-w-3xl text-lg font-medium leading-8 text-[#2f3a49] sm:text-xl lg:text-2xl">
                        Run matters, evidence, reviews, and audit trails on your machine.
                    </p>

                    <div className="mt-12 flex items-center justify-center gap-3">
                        <Link
                            href="/aletheia/matters"
                            className="inline-flex h-[52px] items-center rounded-full bg-[#111827] px-7 text-base font-semibold text-white shadow-[0_8px_22px_rgba(17,24,39,0.16)] transition-colors hover:bg-[#1f2937]"
                        >
                            Open workspace
                        </Link>
                        <a
                            href="https://github.com/shawliu998/Aletheia"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-[52px] items-center rounded-full border border-white/65 bg-white/36 px-7 text-base font-semibold text-[#1f2937] shadow-[0_8px_22px_rgba(17,24,39,0.06),inset_0_1px_0_rgba(255,255,255,0.82)] backdrop-blur-xl transition-colors hover:bg-white/48"
                        >
                            GitHub
                        </a>
                    </div>
                </div>

                <div className="absolute inset-x-0 bottom-[165px] hidden px-5 md:block">
                    <p className="text-sm font-semibold text-[#798394]">Workspace</p>
                    <div className="mx-auto mt-7 grid max-w-7xl grid-cols-4 items-center gap-8 text-center">
                        {proofItems.map((item) => (
                            <span
                                key={item}
                                className="whitespace-nowrap font-serif text-3xl font-semibold leading-none text-[#111827]/34 lg:text-[2.6rem]"
                            >
                                {item}
                            </span>
                        ))}
                    </div>
                </div>

                <div className="absolute bottom-7 left-5 text-left sm:left-[16.5%]">
                    <Link
                        href="/aletheia/matters"
                        className="text-sm font-semibold text-[#798394] transition-colors hover:text-[#111827]"
                    >
                        Product demo
                    </Link>
                </div>
            </section>
        </main>
    );
}
