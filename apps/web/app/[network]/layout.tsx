"use client";

import { Suspense, use, useEffect, useRef } from "react";
import { notFound, usePathname, useRouter, useSearchParams } from "next/navigation";
import { isValidNetwork, type Network } from "@/config/networks";
import { useNetworkStore } from "@/store/network";
import { useDemolishStore } from "@/store/demolish";
import NavBar from "@/components/layout/NavBar";
import NetworkStats from "@/components/stats/NetworkStats";
import { isSigningRoute } from "@/lib/utils/signing-route";
import RiskDisclaimerModal from "@/components/RiskDisclaimerModal";
import UnresolvedGate from "@/components/execution/UnresolvedGate";
import { LeaveGuardProvider, useLeaveGuard } from "@/components/layout/LeaveGuard";

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

/** Keeps the store on the route's network. Reached mid-close, as by the browser's back button, a
 *  change of network asks first: nothing of the other network shows meanwhile, and staying goes
 *  back without clearing the close. */
function NetworkSync({ network, children }: { network: Network; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const setNetwork = useNetworkStore((s) => s.setNetwork);
  const currentNetwork = useNetworkStore((s) => s.network);
  const reset = useDemolishStore((s) => s.reset);
  const { rule, requestLeave } = useLeaveGuard();
  const changed = currentNetwork !== network;
  const asking = changed && rule.leave === "confirm";
  const askedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!changed) {
      askedFor.current = null;
      setNetwork(network);
      return;
    }
    if (rule.leave === "confirm") {
      if (askedFor.current === network) return;
      askedFor.current = network;
      requestLeave({
        leave: () => setNetwork(network),
        stay: () => router.replace(`/${currentNetwork}${pathname.slice(network.length + 1)}`),
      });
      return;
    }
    reset();
    setNetwork(network);
  }, [
    changed,
    network,
    currentNetwork,
    pathname,
    rule.leave,
    requestLeave,
    router,
    setNetwork,
    reset,
  ]);

  return asking ? null : children;
}

export default function NetworkLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ network: string }>;
}) {
  const { network } = use(params);
  const showStats = !isSigningRoute(usePathname());

  if (!isValidNetwork(network)) notFound();

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
        <LeaveGuardProvider>
          <div className="relative z-10 flex min-h-screen flex-col">
            <NavBar network={network} />
            <main className={showStats ? "flex-1 pb-16 xl:pb-0" : "flex-1"}>
              <NetworkSync network={network}>
                <Suspense fallback={null}>
                  <CloseGate network={network}>{children}</CloseGate>
                </Suspense>
              </NetworkSync>
            </main>
          </div>
        </LeaveGuardProvider>
        {showStats && <NetworkStats />}
      </div>
    </RiskDisclaimerModal>
  );
}
