"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Network } from "@/config/networks";
import UnconfirmedPanel from "./UnconfirmedPanel";
import { findUnresolved } from "@/lib/session/recovery";
import { settleRecorded } from "@/lib/session/settle-unconfirmed";
import { CHECK_FAILED_NOTICE, CLOSE_FINISHED_NOTICE } from "@/lib/utils/user-error";
import type { SessionRecord } from "@/types/session";

interface UnresolvedGateProps {
  network: Network;
  source: string | null;
  children: ReactNode;
}

/**
 * Holds every close page for an account with a transaction whose outcome is unknown. A second
 * transaction signed now would use the same sequence, and the first could still land and pay
 * another destination, so looking the hash up is the only thing on offer.
 */
export default function UnresolvedGate({ network, source, children }: UnresolvedGateProps) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [still, setStill] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const key = `${network}:${source}`;

  useEffect(() => {
    if (!source) return;
    let live = true;
    void findUnresolved(network, source).then((found) => {
      if (!live) return;
      setSession(found);
      setLoaded(key);
    });
    return () => {
      live = false;
    };
  }, [network, source, key]);

  async function check(held: SessionRecord): Promise<void> {
    const outcome = await settleRecorded(held, network);
    setStill(outcome === "unknown");
    if (outcome === "unknown") return;
    if (outcome === "closed") setNotice(CLOSE_FINISHED_NOTICE);
    if (outcome === "failed") setNotice(CHECK_FAILED_NOTICE);
    setSession(null);
  }

  if (!source) return children;
  if (loaded !== key) return null;
  if (notice === CLOSE_FINISHED_NOTICE) {
    return (
      <p role="status" className="max-w-2xl mx-auto px-4 py-8 text-sm text-white/70">
        {notice}
      </p>
    );
  }
  if (session?.unconfirmed) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8">
        <UnconfirmedPanel
          hash={session.unconfirmed.hash}
          stillUnconfirmed={still}
          onCheck={() => void check(session)}
        />
      </div>
    );
  }
  return (
    <>
      {notice && (
        <p role="status" className="max-w-2xl mx-auto px-4 pt-6 text-sm text-white/70">
          {notice}
        </p>
      )}
      {children}
    </>
  );
}
