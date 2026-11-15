import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
import StatsClient from "@/components/marketing/stats/StatsClient";

export const metadata: Metadata = pageMetadata({
  path: "/stats",
  title: "Stats",
  description:
    "Live on-chain traction: accounts closed, XLM recovered, and every transaction hash verified on the Stellar blockchain.",
});

export default function StatsPage() {
  return <StatsClient />;
}
