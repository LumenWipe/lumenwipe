import { test as base, type Request } from "@playwright/test";
import { TIMINGS_ATTACHMENT, type TimingSample } from "../../scripts/durations-report";

export { expect } from "@playwright/test";

// Times every session, mess and close request a test makes and attaches them to its result, so
// scripts/durations.ts can turn a nightly report into the picker's measured ranges.

const BASE = "http://localhost:3002";

function routeOf(request: Request): TimingSample["route"] | null {
  const url = new URL(request.url());
  if (url.origin !== BASE || request.method() !== "POST") return null;
  if (url.pathname === "/api/session") return "session";
  if (/^\/api\/session\/[^/]+\/mess$/.test(url.pathname)) return "mess";
  if (/^\/api\/session\/[^/]+\/(demolish\/round|allowances\/revoke)$/.test(url.pathname)) {
    return "close";
  }
  return null;
}

function stepKinds(body: unknown): Map<string, string> {
  const kinds = new Map<string, string>();
  if (typeof body !== "object" || body === null || !("messPlan" in body)) return kinds;
  if (!Array.isArray(body.messPlan)) return kinds;
  for (const step of body.messPlan as unknown[]) {
    if (typeof step !== "object" || step === null) continue;
    const { id, action } = step as { id?: unknown; action?: { kind?: unknown } };
    if (typeof id === "string" && typeof action?.kind === "string") kinds.set(id, action.kind);
  }
  return kinds;
}

export const test = base.extend<{ timings: void }>({
  timings: [
    async ({ page }, use, testInfo) => {
      const samples: TimingSample[] = [];
      let kinds: Promise<Map<string, string>> = Promise.resolve(new Map());
      const pending: Promise<void>[] = [];
      page.on("requestfinished", (request) => {
        const route = routeOf(request);
        if (!route) return;
        if (route === "session") {
          kinds = request
            .response()
            .then((r) => r?.json())
            .then(stepKinds, () => new Map());
        }
        pending.push(
          (async () => {
            const response = await request.response();
            if (!response?.ok()) return;
            const ms = request.timing().responseEnd;
            if (ms < 0) return;
            let kind: string | null = null;
            if (route === "mess") {
              const stepId = (request.postDataJSON() as { stepId?: unknown } | null)?.stepId;
              kind = typeof stepId === "string" ? ((await kinds).get(stepId) ?? null) : null;
            }
            samples.push({ route, kind, ms });
          })().catch(() => {})
        );
      });
      await use();
      await Promise.all(pending);
      await testInfo.attach(TIMINGS_ATTACHMENT, {
        body: JSON.stringify(samples),
        contentType: "application/json",
      });
    },
    { auto: true },
  ],
});
