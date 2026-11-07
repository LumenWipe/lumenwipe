"use client";

import { Analytics } from "@vercel/analytics/next";
import { redactEvent } from "@/lib/analytics/redact";

/** Vercel page analytics with no query string and no receipt id in any address it reports. */
export default function RedactedAnalytics() {
  return <Analytics beforeSend={redactEvent} />;
}
