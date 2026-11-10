import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // The accessibility specs answer every API call from fixtures and run per PR under their own
  // config (playwright.a11y.config.ts), against the production build.
  testIgnore: "a11y/**",
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
      // The API package's own dev script, not the root `dev:api`: that goes through
      // `bun run --filter`, whose rolling status display, under Playwright, repaints its whole
      // window on every line once stdout is kept below.
      command: "bun run dev",
      cwd: "../api",
      // The API's Nest logger writes one JSON line per event to stdout, which Playwright drops by
      // default. In CI it is kept, prefixed [WebServer] in the nightly's log, so an upstream that
      // throttles the run ("upstream read failed" with its target) is named rather than inferred
      // from the 503 the page shows.
      stdout: process.env.CI ? "pipe" : "ignore",
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
