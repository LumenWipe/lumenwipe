import { UMAMI_BEFORE_SEND, UMAMI_BEFORE_SEND_SCRIPT } from "@/lib/analytics/redact";

/**
 * Umami Cloud page analytics, mounted only by the marketing root layouts, never on an app route.
 * Prerendered with no nonce: the build hashes the inline hook and allows Umami's script and
 * collector on these pages alone (config/marketing-csp.mjs). The hook runs first, so no payload
 * leaves unredacted.
 */
export default function UmamiAnalytics() {
  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  if (!websiteId) return null;
  return (
    <>
      <script
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: UMAMI_BEFORE_SEND_SCRIPT }}
      />
      <script
        defer
        suppressHydrationWarning
        src="https://cloud.umami.is/script.js"
        data-website-id={websiteId}
        data-exclude-search="true"
        data-exclude-hash="true"
        data-before-send={UMAMI_BEFORE_SEND}
      />
    </>
  );
}
