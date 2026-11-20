import { UMAMI_SCRIPT } from "@/config/marketing-csp.mjs";
import { UMAMI_BEFORE_SEND, UMAMI_BEFORE_SEND_SCRIPT } from "@/lib/analytics/redact";

/**
 * Umami Cloud page analytics, mounted only by the marketing root layouts, never on an app route.
 * The tracker is a pinned copy served from this origin, so no third-party code runs here.
 * Prerendered with no nonce: the build hashes the inline hook and allows Umami's collector on
 * these pages alone (config/marketing-csp.mjs). The hook runs first, so no payload leaves
 * unredacted.
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
        src={UMAMI_SCRIPT}
        data-website-id={websiteId}
        data-exclude-search="true"
        data-exclude-hash="true"
        data-before-send={UMAMI_BEFORE_SEND}
      />
    </>
  );
}
