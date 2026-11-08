import { expect, test } from "@playwright/test";
import { SECURITY_HEADERS } from "../../../config/security-headers.mjs";

// Headers do not depend on the viewport: one project is enough.
test.beforeEach(() => test.skip(test.info().project.name !== "desktop", "viewport-independent"));

for (const path of ["/", "/api/health"]) {
  test(`${path} carries every security header exactly once`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    const raw = res.headersArray();
    for (const { key, value } of SECURITY_HEADERS) {
      const values = raw.filter((h) => h.name.toLowerCase() === key.toLowerCase());
      expect(
        values.map((h) => h.value),
        key
      ).toEqual([value]);
    }
  });
}

test("a page gets the strict nonce CSP with report-to, and /api gets none", async ({ request }) => {
  const page = await request.get("/");
  const csp = page.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'(;|$)/);
  expect(csp).not.toContain("unsafe-eval");
  expect(csp.split("; ").at(-1)).toBe("report-to csp");

  const api = await request.get("/api/health");
  expect(api.headers()["content-security-policy"]).toBeUndefined();
});

test("the report receiver answers 204 and echoes nothing", async ({ request }) => {
  const res = await request.post("/api/csp-report", {
    headers: { "content-type": "application/reports+json" },
    data: JSON.stringify([
      {
        type: "csp-violation",
        body: { effectiveDirective: "img-src", blockedURL: "https://a.example/x" },
      },
    ]),
  });
  expect(res.status()).toBe(204);
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(await res.text()).toBe("");
});
