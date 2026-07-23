"use client";

import { use, useEffect } from "react";
import { notFound } from "next/navigation";
import { isValidNetwork } from "@/config/networks";
import { useNetworkStore } from "@/store/network";
import { useDemolishStore } from "@/store/demolish";
import NavBar from "@/components/layout/NavBar";
import NetworkStats from "@/components/stats/NetworkStats";
import RiskDisclaimerModal from "@/components/RiskDisclaimerModal";

export default function NetworkLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ network: string }>;
}) {
  const { network } = use(params);
  const setNetwork = useNetworkStore((s) => s.setNetwork);
  const currentNetwork = useNetworkStore((s) => s.network);
  const reset = useDemolishStore((s) => s.reset);

  if (!isValidNetwork(network)) notFound();

  useEffect(() => {
    if (currentNetwork !== network) {
      reset(); // Clear state when switching networks
    }
    setNetwork(network as "mainnet" | "testnet");
  }, [network, currentNetwork, setNetwork, reset]);

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[hsl(var(--mkt-bg))]">
      {/* calm instrument backdrop: grain + faint top hairline, matching the marketing surface.
          Absolute (not fixed) so the mix-blend-overlay grain blends against the dark
          wrapper rather than the white compositor canvas (which would grey the ink). */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 mkt-grain" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-stellar/30 to-transparent" />
      </div>
      <div className="relative z-10 flex min-h-screen flex-col">
        <NavBar network={network as "mainnet" | "testnet"} />
        <main className="flex-1 pb-16 xl:pb-0">{children}</main>
      </div>
      <NetworkStats />
      <RiskDisclaimerModal />
    </div>
  );
}
