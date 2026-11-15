import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export const DEFAULT_NEXT_STEP =
  "Connect a wallet or paste the account address. LumenWipe lists what is keeping the account open and shows the full plan before you sign anything.";

/** The step after reading: analyze an account, introduced by the post's own lead when it has one. */
export default function PostNextStep({ lead }: { lead?: string }) {
  return (
    <section aria-labelledby="post-next-step" className="mkt-panel mt-10 rounded-2xl p-6">
      <h2 id="post-next-step" className="mkt-display text-lg font-bold text-white">
        Next step
      </h2>
      <p className="mt-2 mb-5 text-sm leading-relaxed text-white/85">{lead ?? DEFAULT_NEXT_STEP}</p>
      <Button asChild>
        <Link href="/mainnet">
          Analyze an account
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </Button>
    </section>
  );
}
