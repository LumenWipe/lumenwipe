"use client";

import { useEffect } from "react";
import { AnimatePresence, motion, useSpring, useTransform } from "motion/react";
import { CheckCircle2 } from "lucide-react";
import { usePlaygroundStore } from "@/store/playground";

export default function CoreAccount() {
  const phase = usePlaygroundStore((s) => s.phase);
  const accountState = usePlaygroundStore((s) => s.accountState);
  const demoPublic = usePlaygroundStore((s) => s.demoPublic);

  const balance = accountState ? parseFloat(accountState.nativeBalanceLumens) : 0;
  const lockedReserve = accountState ? 1 + accountState.numSubEntries * 0.5 : 0;

  const spring = useSpring(0, { stiffness: 45, damping: 16 });
  useEffect(() => {
    spring.set(balance);
  }, [balance, spring]);
  const display = useTransform(spring, (v) => v.toFixed(2));

  const merged = phase === "COMPLETE";

  return (
    <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
      <AnimatePresence mode="wait">
        {!merged ? (
          <motion.div
            key="core"
            className="relative flex h-24 w-24 sm:h-32 sm:w-32 lg:h-36 lg:w-36 flex-col items-center justify-center rounded-full border border-stellar/40 bg-[hsl(200_16%_8%/0.9)] text-center"
            style={{
              boxShadow: "0 0 0 1px hsl(var(--stellar)/0.25), 0 0 60px hsl(var(--stellar)/0.25)",
            }}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{
              scale: 0,
              opacity: 0,
              filter: "blur(10px)",
              transition: { duration: 0.7, ease: "easeIn" },
            }}
            transition={{ type: "spring", stiffness: 70, damping: 13 }}
          >
            <span className="text-[8px] sm:text-[9px] uppercase tracking-widest text-stellar">
              Demo account
            </span>
            <span className="mt-0.5 sm:mt-1 font-display text-base sm:text-xl lg:text-2xl text-white tabular-nums">
              <motion.span>{display}</motion.span>
            </span>
            <span className="text-[8px] sm:text-[10px] uppercase tracking-widest text-white/40">
              XLM
            </span>
            {accountState && accountState.numSubEntries > 0 && (
              <span className="mt-1 hidden text-[10px] mkt-mono text-value sm:block">
                {lockedReserve.toFixed(1)} XLM locked
              </span>
            )}
            {demoPublic && (
              <span className="mt-1 hidden text-[9px] mkt-mono text-white/30 sm:block">
                {demoPublic.slice(0, 6)}…{demoPublic.slice(-4)}
              </span>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="merged"
            className="flex flex-col items-center gap-2 text-center"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.5, type: "spring", stiffness: 80, damping: 12 }}
          >
            <CheckCircle2 className="h-10 w-10 text-stellar" />
            <span className="font-display text-lg text-white">Account merged</span>
            <span className="text-[11px] mkt-mono text-white/50">
              Every reserve recovered. Nothing left on the ledger.
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
