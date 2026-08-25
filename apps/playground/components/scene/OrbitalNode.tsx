"use client";

import { useEffect } from "react";
import { motion, useReducedMotion, useSpring, useTime, useTransform } from "motion/react";
import { ArrowLeftRight, Database, Gem, KeyRound } from "lucide-react";
import type { SceneNode } from "@/store/playground";

const SCENE_HALF = 280;

const KIND_ICON = {
  trustline: Gem,
  offer: ArrowLeftRight,
  data: Database,
  signer: KeyRound,
} as const;

export default function OrbitalNode({ node }: { node: SceneNode }) {
  const time = useTime();
  const reduced = useReducedMotion();

  const radius = useSpring(1.7, { stiffness: 50, damping: 13, mass: 1.1 });
  useEffect(() => {
    radius.set(node.orbit.radius / SCENE_HALF);
  }, [node.orbit.radius, radius]);

  const angle = useTransform(time, (t) => {
    const drift = reduced ? 0 : (t / 1000 / node.orbit.durationSec) * 360;
    return ((node.orbit.phaseDeg + drift) * Math.PI) / 180;
  });

  const left = useTransform(() => `${50 + Math.cos(angle.get()) * radius.get() * 50}%`);
  const top = useTransform(() => `${50 + Math.sin(angle.get()) * radius.get() * 50}%`);

  const Icon = KIND_ICON[node.kind];
  const converting = node.status === "converting";

  return (
    <motion.div
      className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left, top }}
      initial={{ opacity: 0, scale: 0.2 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{
        opacity: 0,
        scale: 0.3,
        filter: "blur(6px)",
        transition: { duration: 0.55, ease: "easeIn" },
      }}
      transition={{ type: "spring", stiffness: 90, damping: 14 }}
    >
      <motion.div
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] mkt-mono backdrop-blur-sm ${
          converting
            ? "border-value/60 bg-[hsl(var(--value)/0.12)] text-value"
            : "border-white/12 bg-[hsl(200_16%_10%/0.85)] text-white/80"
        }`}
        animate={converting ? { scale: [1, 1.18, 1] } : { scale: 1 }}
        transition={converting ? { duration: 0.9, repeat: Infinity } : undefined}
      >
        <Icon className={`h-3 w-3 shrink-0 ${converting ? "text-value" : "text-stellar"}`} />
        <span className="hidden max-w-[72px] truncate sm:inline">{node.label}</span>
        {node.balance !== null && (
          <span
            className={`hidden max-w-[52px] shrink-0 truncate sm:inline ${converting ? "text-value" : "text-white/45"}`}
          >
            {Number(node.balance).toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </span>
        )}
      </motion.div>
    </motion.div>
  );
}
