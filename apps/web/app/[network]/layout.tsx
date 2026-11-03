"use client";

import { Suspense, use, useEffect } from "react";
import { notFound, usePathname, useSearchParams } from "next/navigation";
import { isValidNetwork, type Network } from "@/config/networks";
import { useNetworkStore } from "@/store/network";
import { useDemolishStore } from "@/store/demolish";
import NavBar from "@/components/layout/NavBar";
import NetworkStats from "@/components/stats/NetworkStats";
import { isSigningRoute } from "@/lib/utils/signing-route";
import RiskDisclaimerModal from "@/components/RiskDisclaimerModal";
import UnresolvedGate from "@/components/execution/UnresolvedGate";

const CLOSE_PAGES = /\/(analyze|review|execute)$/;

/** Every page that can lead to a signature for the account it names. */
function CloseGate({ network, children }: { network: Network; children: React.ReactNode }) {
  const pathname = usePathname();
  const querySource = useSearchParams().get("source");
  const storedSource = useDemolishStore((s) => s.sourceAddress);
  if (!CLOSE_PAGES.test(pathname)) return children;
  return (
    <UnresolvedGate network={network} source={querySource ?? storedSource}>
      {children}
    </UnresolvedGate>
  );
}

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
  const showStats = !isSigningRoute(usePathname());

  if (!isValidNetwork(network)) notFound();

  useEffect(() => {
    if (currentNetwork !== network) {
      reset(); // Clear state when switching networks
    }
    setNetwork(network as "mainnet" | "testnet");
  }, [network, currentNetwork, setNetwork, reset]);

  return (
    <RiskDisclaimerModal>
      <div className="relative min-h-screen overflow-x-clip bg-canvas">
        {/* calm instrument backdrop: grain + faint top hairline, matching the marketing surface.
          Absolute (not fixed) so the mix-blend-overlay grain blends against the dark
          wrapper rather than the white compositor canvas (which would grey the ink). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <div className="absolute inset-0 mkt-grain" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
        </div>
        <div className="relative z-10 flex min-h-screen flex-col">
          <NavBar network={network as "mainnet" | "testnet"} />
          <main className={showStats ? "flex-1 pb-16 xl:pb-0" : "flex-1"}>
            <Suspense fallback={null}>
              <CloseGate network={network}>{children}</CloseGate>
            </Suspense>
          </main>
        </div>
        {showStats && <NetworkStats />}
      </div>
    </RiskDisclaimerModal>
  );
}
