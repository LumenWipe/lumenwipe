import type { Metadata } from "next";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { REGISTRY } from "@/lib/i18n/messages/registry";
import { pageMetadata } from "@/lib/site/pages";
import RegistryClient from "@/components/marketing/registry/RegistryClient";

const T = REGISTRY[SITE_LOCALE];

export const metadata: Metadata = pageMetadata({
  path: "/registry",
  title: T.metadata.title,
  description: T.metadata.description,
});

export default function RegistryPage() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="max-w-2xl">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-5 bg-line-strong" />
          {T.eyebrow}
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">{T.heading}</h1>
        <p className="mt-5 text-body leading-relaxed text-white/70">{T.intro}</p>
        <p className="mt-4 text-body leading-relaxed text-white/70">{T.notDeposit}</p>
      </div>
      <RegistryClient />
    </section>
  );
}
