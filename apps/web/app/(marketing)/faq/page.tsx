import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Faq, { ITEMS } from "@/components/marketing/Faq";
import JsonLd from "@/components/seo/JsonLd";
import { faqJsonLd } from "@/lib/site/structured-data";
import { Button } from "@/components/ui/button";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { FAQ } from "@/lib/i18n/messages/faq";

const T = FAQ[SITE_LOCALE];

export const metadata: Metadata = pageMetadata({
  path: "/faq",
  title: T.page.title,
  description: T.page.description,
});

export default function FaqPage() {
  return (
    <section className="mx-auto max-w-3xl px-5 py-20 lg:px-8 lg:py-24">
      <JsonLd data={faqJsonLd(ITEMS)} />
      <div className="text-center">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-5 bg-line-strong" />
          {T.eyebrow}
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">{T.heading}</h1>
        <p className="mx-auto mt-4 max-w-xl text-white/70">{T.lede}</p>
      </div>

      <div className="mt-12">
        <Faq />
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg" className="group">
          <Link href="/mainnet">
            {T.page.openApp}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="secondary">
          <a href="https://docs.lumenwipe.com" target="_blank" rel="noopener noreferrer">
            {T.page.docs}
          </a>
        </Button>
      </div>
    </section>
  );
}
