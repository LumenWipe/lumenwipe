import type { SceneNode, SceneNodeKind } from "@/store/playground";
import { JUNK_DATA_ENTRIES, JUNK_OFFERS } from "./mess-plan";

// Maps declarative mess-plan node ids ("tl:AIRDROP1", "data:promo_code",
// "offer:0", "signer:extra") to scene nodes with deterministic orbits, so the
// layout is stable across re-renders and identical for every session.

const RING: Record<SceneNodeKind, { radius: number; durationSec: number }> = {
  signer: { radius: 95, durationSec: 26 },
  trustline: { radius: 135, durationSec: 34 },
  data: { radius: 175, durationSec: 44 },
  offer: { radius: 215, durationSec: 56 },
};

const GOLDEN_ANGLE = 137.5;

function offerLabel(index: number): string {
  const o = JUNK_OFFERS[index];
  if (!o) return `Offer #${index + 1}`;
  const sell = o.selling === "native" ? "XLM" : o.selling;
  const buy = o.buying === "native" ? "XLM" : o.buying;
  return `Sell ${sell} → ${buy}`;
}

export function buildSceneNode(nodeId: string, seq: number): SceneNode {
  const [prefix, rest] = nodeId.split(":");

  let kind: SceneNodeKind;
  let label: string;

  switch (prefix) {
    case "tl":
      kind = "trustline";
      label = rest;
      break;
    case "data":
      kind = "data";
      label = JUNK_DATA_ENTRIES.find((d) => d.key === rest)?.key ?? rest;
      break;
    case "offer":
      kind = "offer";
      label = offerLabel(Number(rest));
      break;
    case "signer":
      kind = "signer";
      label = "Forgotten co-signer";
      break;
    default:
      throw new Error(`Unknown scene node id: ${nodeId}`);
  }

  const ring = RING[kind];
  return {
    id: nodeId,
    kind,
    label,
    balance: null,
    status: "incoming",
    txHash: null,
    orbit: {
      radius: ring.radius,
      durationSec: ring.durationSec + (seq % 3) * 4,
      phaseDeg: (seq * GOLDEN_ANGLE) % 360,
    },
  };
}
