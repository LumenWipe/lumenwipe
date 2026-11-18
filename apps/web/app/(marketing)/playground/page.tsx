import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { PLAYGROUND } from "@/lib/i18n/messages/playground";

const T = PLAYGROUND[SITE_LOCALE];

export const metadata: Metadata = pageMetadata({
  path: "/playground",
  title: T.metadata.title,
  description: T.metadata.description,
});

export default function PlaygroundPage() {
  return (
    <section className="mx-auto w-full max-w-2xl px-4 pb-24 pt-24 text-center sm:px-6">
      <p className="mkt-eyebrow mb-3 text-fg-muted">{T.eyebrow}</p>
      <h1 className="mkt-display text-4xl text-white sm:text-5xl">{T.heading}</h1>
      <p className="mt-4 text-base leading-relaxed text-white/70">{T.body}</p>
      <Button asChild size="lg" className="group mt-8">
        <a href="https://playground.lumenwipe.com" target="_blank" rel="noopener noreferrer">
          {T.open}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </a>
      </Button>
      <div className="mt-6">
        <Link
          href="/testnet"
          className="inline-block text-sm text-accent underline-offset-2 hover:underline"
        >
          {T.ownAccount}
        </Link>
      </div>
    </section>
  );
}
