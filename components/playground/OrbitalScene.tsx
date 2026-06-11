"use client";

import { AnimatePresence } from "motion/react";
import { usePlaygroundStore } from "@/store/playground";
import OrbitalNode from "./OrbitalNode";
import CoreAccount from "./CoreAccount";

const RING_FRACTIONS = [95 / 280, 135 / 280, 175 / 280, 215 / 280];

export default function OrbitalScene() {
  const nodes = usePlaygroundStore((s) => s.nodes);
  const visible = nodes.filter((n) => n.status !== "destroyed");

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[600px] select-none">
      {/* Orbit guides */}
      {RING_FRACTIONS.map((f) => (
        <div
          key={f}
          aria-hidden
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.05]"
          style={{ width: `${f * 100}%`, height: `${f * 100}%` }}
        />
      ))}

      <CoreAccount />

      <AnimatePresence>
        {visible.map((node) => (
          <OrbitalNode key={node.id} node={node} />
        ))}
      </AnimatePresence>
    </div>
  );
}
