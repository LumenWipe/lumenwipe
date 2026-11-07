import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { StepType } from "@/types/plan";
import type { IntentOperation } from "@/types/close-api";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";

/** A plan step a transaction carried out: by type, and for a step of one asset or contract, by
 *  that asset or contract, so only that one step matches (see `coveredBy`). */
export interface CoveredStep {
  type: StepType;
  target?: string;
}

function stepsOf(op: IntentOperation, account: string): CoveredStep[] {
  switch (op.type) {
    case "set_options":
      return [{ type: "NORMALIZE_SIGNERS" }];
    case "revoke_sponsorship":
      return [{ type: "REVOKE_SPONSORSHIP" }];
    case "manage_data":
      return [{ type: "REMOVE_DATA_ENTRIES" }];
    case "manage_sell_offer":
      return [{ type: "CANCEL_OFFERS" }];
    case "change_trust":
      return [{ type: Number(op.limit) === 0 ? "REMOVE_TRUSTLINES" : "ADD_TRUSTLINE_FOR_CLAIM" }];
    case "claim_claimable_balance":
      return [{ type: "CLAIM_BALANCES" }];
    case "payment":
      return op.asset === "native" ? [] : [{ type: "HANDLE_ASSETS", target: op.asset }];
    case "path_payment_strict_send":
      return op.sendAsset === "native" ? [] : [{ type: "HANDLE_ASSETS", target: op.sendAsset }];
    case "invoke_host_function":
      // An exit or a token move of this contract, and no other step of the same type.
      return [
        { type: "EXIT_POSITIONS", target: op.contract },
        { type: "HANDLE_ASSETS", target: op.contract },
      ];
    case "account_merge":
      return op.source === account ? [{ type: "MERGE" }, { type: "CLOSE_ACCOUNT" }] : [];
    default:
      return [];
  }
}

/**
 * The plan steps a transaction carried out, read from its own operations, never from what anyone
 * says about it: the same steps the close's own transactions record, with MERGE and CLOSE_ACCOUNT
 * only for a merge of `account`. Used for a transaction the API did not build, such as a
 * pre-authorized one. Each step appears once.
 */
export function stepsCoveredBy(xdr: string, passphrase: string, account: string): CoveredStep[] {
  const tx = TransactionBuilder.fromXdr(xdr, passphrase);
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const seen = new Set<string>();
  const steps: CoveredStep[] = [];
  for (const op of intentFromXdr(inner.toXDR(), passphrase).operations) {
    for (const step of stepsOf(op, account)) {
      const key = `${step.type}|${step.target ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push(step);
    }
  }
  return steps;
}
