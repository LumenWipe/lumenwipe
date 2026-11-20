"use client";

import { useMemo } from "react";
import { usePlaygroundStore } from "@/store/playground";
import { validateSelection } from "@/lib/scenarios";
import { SCENE_HALF, buildSceneNode, orbitAngle, sceneOrder } from "@/lib/scene-model";
import KindIcon, { kindColor } from "./KindIcon";

/**
 * Before a run, the entries the picked selection will add, drawn faintly on the rings they will
 * take, so the empty scene answers "what am I about to see?" and follows the picker live. It is a
 * picture of the plan only: the panel's "This will create on testnet" list says the same in text,
 * so the drawing is hidden from assistive technology.
 */
export function useScenePreview() {
  const phase = usePlaygroundStore((s) => s.phase);
  const nodes = usePlaygroundStore((s) => s.nodes);
  const batchSize = usePlaygroundStore((s) => s.batchSize);
  const selection = usePlaygroundStore((s) => s.selection);
  const unavailable = usePlaygroundStore((s) => s.unavailable);

  return useMemo(() => {
    if (phase !== "IDLE" || nodes.length > 0 || batchSize > 0) return [];
    const result = validateSelection(selection, { unavailable });
    if (!result.ok) return [];
    return sceneOrder(
      result.plan.steps.flatMap((s) => s.nodes).map((spec, seq) => buildSceneNode(spec, seq))
    );
  }, [phase, nodes.length, batchSize, selection, unavailable]);
}

export default function ScenePreview() {
  const preview = useScenePreview();
  if (preview.length === 0) return null;
  return (
    <div aria-hidden className="absolute inset-0">
      {preview.map((node) => {
        const angle = orbitAngle(node.orbit.phaseDeg, node.orbit.durationSec, 0);
        const r = node.orbit.radius / SCENE_HALF;
        return (
          <span
            key={node.id}
            className="absolute flex min-h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-1.5 rounded-full border border-dashed bg-[hsl(var(--scene-node)/0.6)] px-2.5 py-1 text-[11px] mkt-mono text-white/45"
            style={{
              left: `${50 + Math.cos(angle) * r * 50}%`,
              top: `${50 + Math.sin(angle) * r * 50}%`,
              borderColor: kindColor(node.kind),
              opacity: 0.6,
            }}
          >
            <KindIcon kind={node.kind} />
            <span className="hidden max-w-[72px] truncate sm:inline">{node.label}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The line under the scene that says the faint entries are a preview. */
export function ScenePreviewCaption() {
  const preview = useScenePreview();
  if (preview.length === 0) return null;
  const n = preview.length;
  return (
    <p className="mt-4 text-center text-xs text-subtle">
      Preview: the {n} {n === 1 ? "entry" : "entries"} this run adds. Each one lands here as its
      transaction confirms on testnet.
    </p>
  );
}
