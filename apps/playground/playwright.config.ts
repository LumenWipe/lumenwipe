import { defineConfig, devices } from "@playwright/test";

// Testnet only. The playground drives real testnet transactions (Friendbot, Horizon and the real
// API's close loop), so this suite runs nightly and on manual dispatch, never per pull request.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // One retry: each attempt funds fresh testnet accounts, and a second failure is a real one.
  retries: process.env.CI ? 1 : 0,
  // The github reporter writes no report directory on its own, so it is paired with html to give
  // the nightly something to upload.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3002",
    // Kept only for a failed test. No spec calls the credentials route, so a trace never holds a
    // demo secret.
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The demolish goes through the real API, so both services start here.
  webServer: [
    {
      command: "bun run dev:api",
      cwd: "../..",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Creates this run's testnet accounts, then starts `next dev` (see tests/e2e/serve.ts).
      command: "bun tests/e2e/serve.ts",
      url: "http://localhost:3002",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
