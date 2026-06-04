"use client";

import { use, useEffect } from "react";
import { notFound } from "next/navigation";
import { isValidNetwork } from "@/config/networks";
import { useNetworkStore } from "@/store/network";
import { useDemolishStore } from "@/store/demolish";
import NavBar from "@/components/layout/NavBar";

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
    <div className="relative min-h-screen overflow-x-clip bg-[#07070b]">
      {/* calm instrument backdrop, quieter than the landing */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 mkt-grid opacity-40" />
        <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_50%_0%,hsl(196_100%_47%/0.07),transparent)]" />
      </div>
      <div className="relative z-10 flex min-h-screen flex-col">
        <NavBar network={network as "mainnet" | "testnet"} />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
