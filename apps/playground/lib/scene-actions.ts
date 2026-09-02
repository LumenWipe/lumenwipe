import type { IntentOperation } from "@lumenwipe/sdk";

/** What a confirmed close operation should do to the orbital scene. `destroy`
 *  carries every node id it applies to (offers are destroyed as a batch - see
 *  the plan's "Design correction" note; trustlines and data entries are
 *  destroyed one at a time since each operation already names its own asset
 *  or key). */
export type SceneAction =
  | { type: "destroy"; nodeIds: string[] }
  | { type: "pulse"; nodeId: string }
  | { type: "merge" };

const trustlineNodeId = (asset: string): string => {
  const code = asset.includes(":") ? asset.split(":")[0] : asset;
  return `tl:${code}`;
};

/**
 * Maps one confirmed close operation to the scene action it should trigger,
 * given which node ids are currently alive. Returns null when the operation
 * has no visual counterpart (an unknown/unhandled type, a threshold-only
 * SetOptions, or a target that isn't currently in the scene).
 */
export function operationToSceneAction(
  op: IntentOperation,
  liveNodeIds: string[]
): SceneAction | null {
  switch (op.type) {
    case "change_trust": {
      const nodeId = trustlineNodeId(op.asset);
      return liveNodeIds.includes(nodeId) ? { type: "destroy", nodeIds: [nodeId] } : null;
    }
    case "manage_data": {
      const nodeId = `data:${op.name}`;
      return liveNodeIds.includes(nodeId) ? { type: "destroy", nodeIds: [nodeId] } : null;
    }
    case "manage_sell_offer": {
      const offerNodeIds = liveNodeIds.filter((id) => id.startsWith("offer:"));
      return offerNodeIds.length > 0 ? { type: "destroy", nodeIds: offerNodeIds } : null;
    }
    case "set_options": {
      if (!op.signer || op.signer.weight !== 0) return null;
      return liveNodeIds.includes("signer:extra")
        ? { type: "destroy", nodeIds: ["signer:extra"] }
        : null;
    }
    case "payment": {
      const nodeId = trustlineNodeId(op.asset);
      return liveNodeIds.includes(nodeId) ? { type: "pulse", nodeId } : null;
    }
    case "account_merge":
      return { type: "merge" };
    case "path_payment_strict_send":
    case "claim_claimable_balance":
    case "revoke_sponsorship":
    case "invoke_host_function":
    case "unknown":
      return null;
  }
}
