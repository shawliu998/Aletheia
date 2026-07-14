import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: ".",
    testMatch: [
        "vera-projects-overview-source.spec.ts",
        "vera-project-workspace-source.spec.ts",
    ],
    fullyParallel: false,
    workers: 1,
    reporter: [["list"]],
});
