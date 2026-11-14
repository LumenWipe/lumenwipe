import { SCENE_NODE_KINDS, type MessStepDef, type SceneNodeSpec } from "./scenarios";
import type { SceneNode, SceneNodeKind, SceneNodeStatus } from "@/store/playground";

// What the scene draws, as data: the orbit, its list view, its legend and a batch member's entries
// all read this module, so the picture and the text cannot say different things.

/** The orbit's coordinate system: a ring's radius is a share of this half-width. */
export const SCENE_HALF = 280;

interface KindMeta {
  /** What one node of this kind is, in the visitor's words; the start of its accessible name. */
  name: string;
  /** The legend's line for the kind. */
  meaning: string;
  radius: number;
  durationSec: number;
}

/**
 * Every kind, inner ring first. The account's own entries orbit close to it, and what lives
 * elsewhere (a contract, an entry of its own, another account) orbits outside them. The outer
 * ring stays at 240 so a node at 320 px still fits inside the scene.
 */
export const KIND_META: Record<SceneNodeKind, KindMeta> = {
  signer: {
    name: "Signer",
    meaning: "An extra key on the account",
    radius: 150,
    durationSec: 26,
  },
  multisig: {
    name: "Multi-signature signer",
    meaning: "A signer the close needs, or removes first",
    radius: 150,
    durationSec: 30,
  },
  trustline: {
    name: "Trustline",
    meaning: "An asset the account holds",
    radius: 175,
    durationSec: 34,
  },
  data: {
    name: "Data entry",
    meaning: "A key and value on the account",
    radius: 200,
    durationSec: 44,
  },
  offer: { name: "Offer", meaning: "An open order on the DEX", radius: 220, durationSec: 56 },
  generic: {
    name: "Entry",
    meaning: "Something else the run created",
    radius: 220,
    durationSec: 48,
  },
  position: {
    name: "Protocol position",
    meaning: "Funds deposited in a DeFi contract",
    radius: 240,
    durationSec: 64,
  },
  allowance: {
    name: "Token allowance",
    meaning: "A spender allowed to move the demo's tokens",
    radius: 240,
    durationSec: 72,
  },
  claimable: {
    name: "Claimable balance",
    meaning: "A balance waiting to be claimed",
    radius: 240,
    durationSec: 68,
  },
  sponsorship: {
    name: "Sponsored reserve",
    meaning: "Another account's entry whose reserve the demo pays",
    radius: 240,
    durationSec: 60,
  },
};

/** The kinds in ring order, which is the order the legend, the list and the keyboard follow. */
export const KIND_ORDER: readonly SceneNodeKind[] = Object.keys(KIND_META) as SceneNodeKind[];

/** The guide rings: one per distinct radius, as a share of the scene's width. */
export const GUIDE_RINGS: readonly number[] = [
  ...new Set(KIND_ORDER.map((k) => KIND_META[k].radius)),
].map((r) => r / SCENE_HALF);

const GOLDEN_ANGLE = 137.5;

const sceneKind = (kind: string): SceneNodeKind =>
  SCENE_NODE_KINDS.find((k) => k === kind) ?? "generic";

/** A plan's node spec as the scene draws it. A kind this client does not know renders as a generic
 *  node rather than failing the run, which would strand a funded account. */
export function buildSceneNode(
  spec: Omit<SceneNodeSpec, "kind"> & { kind: string },
  seq: number
): SceneNode {
  const { id, label } = spec;
  const kind = sceneKind(spec.kind);
  const ring = KIND_META[kind];
  return {
    id,
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
    offer: spec.offer ?? null,
    offerId: null,
  };
}

/** The nodes a batch member's completed steps created, removed once the member is merged. */
export function planNodes(
  steps: readonly MessStepDef[],
  done: number,
  removed: boolean
): SceneNode[] {
  const status: SceneNodeStatus = removed ? "destroyed" : "docked";
  return steps
    .slice(0, done)
    .flatMap((s) => s.nodes)
    .map((spec, seq) => ({ ...buildSceneNode(spec, seq), status }));
}

export const formatBalance = (balance: string): string =>
  Number(balance).toLocaleString("en-US", { maximumFractionDigits: 2 });

const STATUS_TEXT: Record<SceneNodeStatus, string> = {
  incoming: "on testnet",
  docked: "on testnet",
  converting: "being converted to XLM",
  destroyed: "removed",
};

/** One node in words: what it is, its label and balance, and where it stands. */
export function nodeAccessibleName(node: SceneNode): string {
  const balance = node.balance === null ? "" : `, balance ${formatBalance(node.balance)}`;
  return `${KIND_META[node.kind].name} ${node.label}${balance}, ${STATUS_TEXT[node.status]}`;
}

/** The nodes in ring order, then in the order they were created. */
export function sceneOrder(nodes: readonly SceneNode[]): SceneNode[] {
  const rank = (n: SceneNode): number => KIND_ORDER.indexOf(n.kind);
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => rank(a.node) - rank(b.node) || a.index - b.index)
    .map(({ node }) => node);
}

/** The kinds the scene holds, each once, in ring order. */
export function legendKinds(nodes: readonly SceneNode[]): SceneNodeKind[] {
  return KIND_ORDER.filter((kind) => nodes.some((n) => n.kind === kind));
}

/** Whether the orbit stands still: the visitor asked for less motion, or paused it, or is
 *  pointing at or focused on a node. */
export const sceneStill = (reducedMotion: boolean, paused: boolean, held: boolean): boolean =>
  reducedMotion || paused || held;

/** A node's angle in radians after drifting for `driftedMs`. */
export function orbitAngle(phaseDeg: number, durationSec: number, driftedMs: number): number {
  const drift = (driftedMs / 1000 / durationSec) * 360;
  return ((phaseDeg + drift) * Math.PI) / 180;
}

/** Where a key press moves the focus among `count` nodes, or null for a key the orbit ignores. */
export function nextFocusIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
