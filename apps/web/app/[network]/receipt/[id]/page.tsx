"use client";

import { use } from "react";
import type { Network } from "@/config/networks";
import SavedReceipt from "@/components/receipt/SavedReceipt";

export default function ReceiptPage({
  params,
}: {
  params: Promise<{ network: Network; id: string }>;
}) {
  const { network, id } = use(params);
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <SavedReceipt network={network} id={decodeURIComponent(id)} />
    </div>
  );
}
