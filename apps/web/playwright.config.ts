import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The github reporter only emits inline annotations - it writes no playwright-report/
  // directory. On its own it left the nightly's uploaded artifact empty, while the failure
  // issue told whoever triaged it to go read that artifact. Pair it with the html reporter so
  // there is something to upload.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Both services, because the web reaches the backend only through its own proxy - a suite
  // started against the web alone fails on the first analyze with a connection error that
  // looks like an application bug. Starting them here means `bun test:e2e` works from a clean
  // checkout instead of depending on a second terminal nobody documented.
  webServer: [
    {
      command: "bun run dev:api",
      cwd: "../..",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "bun run dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
