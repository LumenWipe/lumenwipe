"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import ExecutionWizard from "@/components/execution/ExecutionWizard";

export default function ExecutePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { executionPlan, sourceAddress } = useDemolishStore();

  useEffect(() => {
    if (!sourceAddress || executionPlan.length === 0) {
      router.replace(`/${network}`);
    }
  }, [sourceAddress, executionPlan.length, network, router]);

  if (!sourceAddress || executionPlan.length === 0) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Link
          href={`/${network}/analyze`}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="mkt-display text-xl font-bold text-white">Executing plan</h1>
        <span className="text-xs text-white/45 ml-auto mkt-mono">
          {sourceAddress.slice(0, 8)}...
        </span>
      </div>

      <ExecutionWizard network={network} />
    </div>
  );
}
