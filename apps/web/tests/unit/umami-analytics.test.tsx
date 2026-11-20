import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UMAMI_SCRIPT } from "@/config/marketing-csp.mjs";
import UmamiAnalytics from "@/components/analytics/UmamiAnalytics";
import { UMAMI_BEFORE_SEND, UMAMI_BEFORE_SEND_SCRIPT } from "@/lib/analytics/redact";
import { pageScripts } from "@/scripts/marketing-csp.mjs";

const saved = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  else process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = saved;
});

test("renders nothing unless the deployment sets an Umami website id", () => {
  delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  expect(renderToStaticMarkup(<UmamiAnalytics />)).toBe("");
  process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = "";
  expect(renderToStaticMarkup(<UmamiAnalytics />)).toBe("");
});

test("defines the redaction hook, then loads the policy's Umami script with it, dropping query and fragment", () => {
  process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = "00000000-0000-4000-8000-000000000001";
  const html = renderToStaticMarkup(<UmamiAnalytics />);
  expect(pageScripts(html)).toEqual({
    inline: [UMAMI_BEFORE_SEND_SCRIPT],
    external: [UMAMI_SCRIPT],
  });
  const tag = /<script\b([^>]*\ssrc="[^"]*"[^>]*)>/.exec(html)?.[1] ?? "";
  expect(tag).toContain(' data-website-id="00000000-0000-4000-8000-000000000001"');
  expect(tag).toContain(' data-exclude-search="true"');
  expect(tag).toContain(' data-exclude-hash="true"');
  expect(tag).toContain(` data-before-send="${UMAMI_BEFORE_SEND}"`);
  expect(tag).toContain(" defer");
  expect(html.indexOf(UMAMI_BEFORE_SEND_SCRIPT)).toBeLessThan(html.indexOf(UMAMI_SCRIPT));
});
