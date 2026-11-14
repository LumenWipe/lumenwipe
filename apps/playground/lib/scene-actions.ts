import type { IntentOperation } from "@lumenwipe/sdk";
import { AQUARIUS, BLEND, BLEND_REQUEST, PHOENIX, pinnedAssetOf, SOROSWAP } from "./scenarios";

/** What a confirmed close operation does to the orbital scene. */
export type SceneAction =
  { type: "destroy"; nodeIds: string[] } | { type: "pulse"; nodeId: string } | { type: "merge" };

/** A node still in the scene; an offer node carries the chain's offer id once it is bound. */
export interface LiveNode {
  id: string;
  offerId?: string | null;
}

type OperationType = IntentOperation["type"];

type Handler<T extends OperationType> = (
  op: Extract<IntentOperation, { type: T }>,
  live: readonly LiveNode[]
) => SceneAction | null;

/** A pinned asset's node is named for the asset, so it never collides with a playground code. */
const trustlineNodeId = (asset: string): string =>
  `tl:${pinnedAssetOf(asset) ?? asset.split(":")[0]}`;

/** The position node each protocol's exit calls act on, by the contract and function called. */
const POSITION_NODE_BY_EXIT: ReadonlyMap<string, { fn: string; nodeId: string }> = new Map([
  [SOROSWAP.router, { fn: "remove_liquidity", nodeId: "lp:soroswap" }],
  [AQUARIUS.pool, { fn: "withdraw", nodeId: "lp:aquarius" }],
  [BLEND.pool, { fn: "submit", nodeId: "lend:blend" }],
  [PHOENIX.pool, { fn: "withdraw_liquidity", nodeId: "lp:phoenix" }],
  [PHOENIX.stake, { fn: "unbond", nodeId: "lp:phoenix" }],
]);

/**
 * Whether a Blend `submit` only repays: the exit's first step when the demo borrowed, which leaves
 * the collateral in place. The intent renders the requests as JSON (`args[3]`).
 */
function onlyRepays(args: readonly string[]): boolean {
  try {
    const requests: unknown = JSON.parse(args[3] ?? "");
    return (
      Array.isArray(requests) &&
      requests.length > 0 &&
      requests.every(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          (r as { request_type?: unknown }).request_type === BLEND_REQUEST.repay
      )
    );
  } catch {
    return false;
  }
}

const destroyIfLive = (live: readonly LiveNode[], nodeId: string): SceneAction | null =>
  live.some((n) => n.id === nodeId) ? { type: "destroy", nodeIds: [nodeId] } : null;

const pulseIfLive = (live: readonly LiveNode[], nodeId: string): SceneAction | null =>
  live.some((n) => n.id === nodeId) ? { type: "pulse", nodeId } : null;

/** The scene nodes a removed signer of each type can stand for, in the order they are taken. */
const SIGNER_NODES: Partial<Record<string, readonly string[]>> = {
  ed25519_public_key: ["signer:extra", "signer:cosigner:1", "signer:cosigner:2"],
  hash_x: ["signer:hashx"],
  preauth_tx: ["signer:preauth"],
};

/** The claimable balance nodes a close's own claim can stand for: never a locked balance, which it
 *  leaves behind, nor one the demo created for another account, which only that account claims. */
const CLAIMED_BY_CLOSE = ["cb:claim:", "cb:add_trustline_then_claim:"];

/** The sponsorship node a revoke of another account's entry stands for, by the entry's kind. */
const SPONSORSHIP_NODES: Partial<Record<string, string>> = {
  trustline: "sponsorship:trustline",
  data_entry: "sponsorship:data",
};

/** The nodes a playground resolution clears, by the blocker it resolves: the claimant claims the
 *  balance the demo created, or the other account removes the entries the demo paid for. */
const RESOLVED_PREFIX: Partial<Record<string, string>> = {
  sponsorship_claimable_balance_unrevocable: "cb:demo_sponsored:",
  sponsorship_unaffordable: "sponsorship:",
};

/** The live nodes a successful resolution of `blocker` removes from the scene. */
export function nodesResolvedBy(blocker: string, live: readonly LiveNode[]): string[] {
  const prefix = RESOLVED_PREFIX[blocker];
  return prefix ? live.filter((n) => n.id.startsWith(prefix)).map((n) => n.id) : [];
}

/** No visual: the operation changes nothing the scene draws. */
const noVisual = (): null => null;

/**
 * One entry per close operation type, so a new type cannot be added to the API's intent without
 * deciding what the scene does with it.
 */
export const SCENE_HANDLERS: { [T in OperationType]: Handler<T> } = {
  change_trust: (op, live) => destroyIfLive(live, trustlineNodeId(op.asset)),
  manage_data: (op, live) => destroyIfLive(live, `data:${op.name}`),
  // Only the offer this operation cancels: an offer node is bound to its chain id after the mess.
  manage_sell_offer: (op, live) => {
    const node = live.find((n) => n.offerId === op.offerId);
    return node ? { type: "destroy", nodeIds: [node.id] } : null;
  },
  set_options: (op, live) => {
    if (!op.signer || op.signer.weight !== 0) return null;
    const candidates = SIGNER_NODES[op.signer.type] ?? [];
    const node = candidates.find((id) => live.some((n) => n.id === id));
    return node ? { type: "destroy", nodeIds: [node] } : null;
  },
  payment: (op, live) => pulseIfLive(live, trustlineNodeId(op.asset)),
  account_merge: () => ({ type: "merge" }),
  // A conversion empties the trustline into XLM, as a payment out of it does.
  path_payment_strict_send: (op, live) => pulseIfLive(live, trustlineNodeId(op.sendAsset)),
  // The close claims balances in an order of its own; any one of them stands for the claim.
  claim_claimable_balance: (_op, live) => {
    const node = live.find((n) => CLAIMED_BY_CLOSE.some((prefix) => n.id.startsWith(prefix)));
    return node ? { type: "destroy", nodeIds: [node.id] } : null;
  },
  revoke_sponsorship: (op, live) => {
    const nodeId = SPONSORSHIP_NODES[op.entryKind];
    return nodeId ? destroyIfLive(live, nodeId) : null;
  },
  invoke_host_function: (op, live) => {
    const exit = POSITION_NODE_BY_EXIT.get(op.contract);
    if (!exit || exit.fn !== op.function) return null;
    // A repay leaves the collateral, so the position stays; the withdrawal after it empties it.
    if (op.contract === BLEND.pool && onlyRepays(op.args)) return pulseIfLive(live, exit.nodeId);
    // An unbond only moves the shares back to the demo; the withdrawal after it empties the pool.
    if (op.contract === PHOENIX.stake) return pulseIfLive(live, exit.nodeId);
    return destroyIfLive(live, exit.nodeId);
  },
  unknown: noVisual,
};

function handle<T extends OperationType>(
  op: Extract<IntentOperation, { type: T }>,
  live: readonly LiveNode[]
): SceneAction | null {
  const handler: Handler<T> = SCENE_HANDLERS[op.type];
  return handler(op, live);
}

/** Maps one confirmed close operation to its scene action, given the nodes still in the scene. */
export function operationToSceneAction(
  op: IntentOperation,
  live: readonly LiveNode[]
): SceneAction | null {
  return handle(op, live);
}
