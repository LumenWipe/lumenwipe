"use client";

import { useEffect, useState } from "react";
import { findResumableSession } from "@/lib/session/recovery";
import type { SessionRecord } from "@/types/session";
import type { Network } from "@/config/networks";

export function useSessionRecovery(network: Network) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    findResumableSession(network)
      .then((s) => {
        setSession(s);
        setChecked(true);
      })
      .catch((err) => {
        console.error("[session] recovery failed:", err);
        setChecked(true);
      });
  }, [network]);

  return { session, checked, clearSession: () => setSession(null) };
}
