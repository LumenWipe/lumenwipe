"use client";

import { useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n/locale";
import { STATUS } from "@/lib/i18n/messages/status";
import {
  affectedComponents,
  parseStatusSummary,
  type AffectedComponent,
} from "@/lib/status/summary";

/** The route caches for as long, so a shorter interval would only re-read the same answer. */
const POLL_INTERVAL_MS = 60_000;

interface Affected {
  components: AffectedComponent[];
  page: string;
}

function httpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** What to show for a `/api/status` answer: null for nothing to show, or anything unreadable. */
async function readAffected(): Promise<Affected | null> {
  const res = await fetch("/api/status");
  if (res.status !== 200) return null;
  const body: unknown = await res.json();
  const summary = parseStatusSummary(body);
  const page = httpsOrigin((body as { page?: unknown } | null)?.page);
  if (!summary || !page) return null;
  const components = affectedComponents(summary);
  return components.length > 0 ? { components, page } : null;
}

/**
 * Names the close-flow services the status page reports as degraded or down. It renders nothing
 * otherwise, including when the status host cannot be read, so it never reads as an all-clear.
 */
export default function StatusBanner({ locale }: { locale: Locale }) {
  const [affected, setAffected] = useState<Affected | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      const next = await readAffected().catch(() => null);
      if (active) setAffected(next);
    }
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (!affected) return null;
  const copy = STATUS[locale];
  return (
    <div
      role="status"
      aria-label={copy.label}
      className="relative z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning"
    >
      <ul className="flex flex-wrap gap-x-3">
        {affected.components.map(({ id, state }) => (
          <li key={id}>
            {copy.components[id]}: {copy.states[state]}
          </li>
        ))}
      </ul>
      <a href={affected.page} className="underline underline-offset-2">
        {copy.details}
      </a>
    </div>
  );
}
