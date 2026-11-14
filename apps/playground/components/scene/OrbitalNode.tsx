"use client";

import { useEffect, useRef } from "react";
import {
  motion,
  useAnimationFrame,
  useIsPresent,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";
import type { SceneNode } from "@/store/playground";
import { SCENE_HALF, formatBalance, nodeAccessibleName, orbitAngle } from "@/lib/scene-model";
import KindIcon, { kindColor } from "./KindIcon";

export interface OrbitalNodeProps {
  node: SceneNode;
  /** The orbit stands still: no drift, and the node takes its ring at once. */
  still: boolean;
  /** This node holds the orbit's one tab stop. */
  tabStop: boolean;
  /** Its label and balance are shown on every screen width. */
  expanded: boolean;
  onFocus: () => void;
  onToggle: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}

export default function OrbitalNode({
  node,
  still,
  tabStop,
  expanded,
  onFocus,
  onToggle,
  buttonRef,
}: OrbitalNodeProps) {
  // Time spent drifting, which stops while the orbit stands still so that it resumes from where
  // it stopped rather than jumping ahead.
  const drifted = useMotionValue(0);
  const stillRef = useRef(still);
  useEffect(() => {
    stillRef.current = still;
  }, [still]);
  useAnimationFrame((_, delta) => {
    if (!stillRef.current) drifted.set(drifted.get() + delta);
  });

  const radius = useSpring(1.7, { stiffness: 50, damping: 13, mass: 1.1 });
  useEffect(() => {
    const target = node.orbit.radius / SCENE_HALF;
    if (still) radius.jump(target);
    else radius.set(target);
  }, [node.orbit.radius, radius, still]);

  const angle = useTransform(drifted, (ms) =>
    orbitAngle(node.orbit.phaseDeg, node.orbit.durationSec, ms)
  );
  const left = useTransform(() => `${50 + Math.cos(angle.get()) * radius.get() * 50}%`);
  const top = useTransform(() => `${50 + Math.sin(angle.get()) * radius.get() * 50}%`);

  // A removed node stays mounted for its exit animation; it is out of reach meanwhile.
  const present = useIsPresent();
  const converting = node.status === "converting";
  const shown = expanded ? "inline" : "hidden sm:inline";

  return (
    <motion.li
      className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left, top }}
      inert={!present}
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
      <motion.button
        ref={buttonRef}
        type="button"
        tabIndex={present && tabStop ? 0 : -1}
        aria-label={nodeAccessibleName(node)}
        aria-expanded={expanded}
        onFocus={onFocus}
        onClick={onToggle}
        className={`flex min-h-6 min-w-6 items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] mkt-mono backdrop-blur-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
          converting
            ? "bg-[hsl(var(--value)/0.12)] text-value"
            : "bg-[hsl(var(--scene-node)/0.85)] text-white/80"
        }`}
        style={{ borderColor: converting ? "hsl(var(--value))" : kindColor(node.kind) }}
        animate={converting ? { scale: [1, 1.18, 1] } : { scale: 1 }}
        transition={converting ? { duration: 0.9, repeat: Infinity } : undefined}
      >
        <KindIcon kind={node.kind} />
        <span className={`${shown} max-w-[72px] truncate`}>{node.label}</span>
        {node.balance !== null && (
          <span
            className={`${shown} max-w-[52px] shrink-0 truncate ${converting ? "text-value" : "text-subtle"}`}
          >
            {formatBalance(node.balance)}
          </span>
        )}
      </motion.button>
    </motion.li>
  );
}
