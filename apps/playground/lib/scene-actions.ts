import type { IntentOperation } from "@lumenwipe/sdk";
import { pinnedAssetOf, SOROSWAP } from "./scenarios";

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

/** The position node each protocol's exit call empties, by the contract it calls. */
const POSITION_NODE_BY_EXIT: ReadonlyMap<string, { fn: string; nodeId: string }> = new Map([
  [SOROSWAP.router, { fn: "remove_liquidity", nodeId: "lp:soroswap" }],
]);

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
  claim_claimable_balance: noVisual,
  revoke_sponsorship: noVisual,
  invoke_host_function: (op, live) => {
    const exit = POSITION_NODE_BY_EXIT.get(op.contract);
    return exit && exit.fn === op.function ? destroyIfLive(live, exit.nodeId) : null;
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
