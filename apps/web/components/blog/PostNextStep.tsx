import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";

/** The step after reading: analyze an account, introduced by the post's own lead when it has one. */
export default function PostNextStep({ lead, locale }: { lead?: string; locale: Locale }) {
  const T = BLOG[locale].post;
  return (
    <section aria-labelledby="post-next-step" className="mkt-panel mt-10 rounded-2xl p-6">
      <h2 id="post-next-step" className="mkt-display text-lg font-bold text-white">
        {T.nextStep}
      </h2>
      <p className="mt-2 mb-5 text-sm leading-relaxed text-white/85">{lead ?? T.nextStepLead}</p>
      <Button asChild>
        <Link href="/mainnet">
          {T.analyzeAccount}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </Button>
    </section>
  );
}
