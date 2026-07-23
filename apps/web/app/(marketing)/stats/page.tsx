import type { Metadata } from "next";
import StatsClient from "@/components/marketing/stats/StatsClient";

export const metadata: Metadata = {
  title: "Stats · LumenWipe",
  description:
    "Live on-chain traction: accounts closed, XLM recovered, and every transaction hash verified on the Stellar blockchain.",
};

export default function StatsPage() {
  return <StatsClient />;
}
