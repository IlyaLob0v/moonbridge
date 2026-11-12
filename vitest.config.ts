import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "coverage",
      // The screens (apps/web/src/platform, ui, the Moonbridge views) are checked by the e2e runs
      // on phone screens, not by percentages; command-line scripts are run by hand.
      include: ["packages/*/src/**", "apps/server/src/**", "apps/web/src/core/**", "apps/web/src/net/**", "apps/web/src/storage/**", "apps/web/src/moonbridge/{daily,progress,runner}.ts"],
      exclude: ["**/cli.ts", "**/cli/**", "apps/server/src/main.ts"],
      // A floor just under today's numbers (2026-11-12): CI fails when a change lowers coverage.
      // Raise them when coverage grows; never lower them to make a change pass.
      thresholds: {
        "packages/*/src/**": { lines: 93, branches: 80, functions: 95 },
        "apps/server/src/**": { lines: 95, branches: 86, functions: 94 },
        "apps/web/src/{core,net,storage}/**": { lines: 62, branches: 80 },
      },
    },
  },
});
