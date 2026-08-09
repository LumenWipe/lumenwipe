import { TransactionBuilder, Memo, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type {
  AccountSigner,
  ClaimableBalance,
  ConversionPath,
  DataEntry,
  OpenOffer,
  StepType,
  Trustline,
} from "@lumenwipe/types";
import { signerNormalizationOps } from "./signers";
import { dataEntryRemovalOps } from "./data-entries";
import { offerCancellationOps } from "./offers";
import { assetConversionOp, issuerPaymentOp } from "./asset-conversion";
import { claimBalanceOps } from "./claimable-balances";
import { trustlineAddForClaimOps, trustlineRemovalOps } from "./trustlines";
import { mergeOp } from "./merge";

/**
 * Per-asset disposition. A held asset is either swapped to XLM via a path
 * payment (`convert`) or returned to its issuer via a direct payment
 * (`issuer`). The action is the user's decision, carried from the analyze step.
 */
export type AssetAction =
  | { trustline: Trustline; action: "convert"; path: ConversionPath }
  | { trustline: Trustline; action: "issuer" };

export interface FusedCloseInput {
  needsSignerNormalization: boolean;
  signers: AccountSigner[];
  dataEntries: DataEntry[];
  openOffers: OpenOffer[];
  /** Balances the account can claim without further remediation. */
  claimableBalances: ClaimableBalance[];
  /** Balances that need a trustline added first (the claim-remediation path) - claimed in the
   *  same batch as `claimableBalances`, but preceded by an ADD_TRUSTLINE_FOR_CLAIM op each. */
  trustlinesToAddForClaim: ClaimableBalance[];
  assetActions: AssetAction[];
  trustlines: Trustline[];
  destinationAddress: string;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  includeMerge: boolean;
}

/** A close operation tagged with the plan step it belongs to. */
export interface TaggedCloseOp {
  op: xdr.Operation;
  step: StepType;
}

/**
 * Assembles the ordered close operations, each tagged with its plan step. Pure:
 * account id and input in, tagged operations out, no network side effects. Order
 * is fixed: signer normalization, data removal, offer cancellation, trustlines added
 * for claim remediation, claimable-balance claiming, per-asset disposition, trustline
 * removal, and (for direct destinations) the account merge - so by the time accountMerge
 * runs every subentry is already gone. Trustline-adding runs immediately before claiming
 * so a remediated balance is never claimed against a still-untrusted asset; claiming runs
 * before the asset dispositions because a claim raises the held balance an action spends.
 * The tags let a multi-transaction (batched) close report which steps each transaction covers.
 */
export function assembleFusedCloseOpsTagged(
  masterKey: string,
  input: FusedCloseInput
): TaggedCloseOp[] {
  const tagged: TaggedCloseOp[] = [];
  const push = (step: StepType, ops: xdr.Operation[]) => {
    for (const op of ops) tagged.push({ op, step });
  };
  if (input.needsSignerNormalization) {
    push("NORMALIZE_SIGNERS", signerNormalizationOps(input.signers, masterKey));
  }
  push("REMOVE_DATA_ENTRIES", dataEntryRemovalOps(input.dataEntries));
  push("CANCEL_OFFERS", offerCancellationOps(input.openOffers));
  push("ADD_TRUSTLINE_FOR_CLAIM", trustlineAddForClaimOps(input.trustlinesToAddForClaim));
  push("CLAIM_BALANCES", claimBalanceOps(input.claimableBalances));
  for (const a of input.assetActions) {
    push("CONVERT_ASSETS", [
      a.action === "convert"
        ? assetConversionOp(masterKey, a.trustline, a.path)
        : issuerPaymentOp(a.trustline),
    ]);
  }
  push("REMOVE_TRUSTLINES", trustlineRemovalOps(input.trustlines));
  if (input.includeMerge) push("MERGE", [mergeOp(input.destinationAddress)]);
  return tagged;
}

/**
 * The ordered close operation list (untagged). Exported so the step engine can
 * count operations before building. Derived from the tagged assembler so the
 * operation order lives in exactly one place.
 */
export function assembleFusedCloseOps(masterKey: string, input: FusedCloseInput): xdr.Operation[] {
  return assembleFusedCloseOpsTagged(masterKey, input).map((t) => t.op);
}

/**
 * Builds one atomic classic transaction that closes an account: signer
 * normalization, data removal, offer cancellation, claimable-balance claiming,
 * per-asset disposition (swap to XLM or return to issuer), trustline removal,
 * and (for direct destinations) the account merge. Operations apply in order,
 * so by the time accountMerge runs every subentry is already gone.
 *
 * FUTURE: when swap execution moves to the Soroswap aggregator, conversion
 * becomes a Soroban InvokeHostFunction, which a transaction may not mix with any
 * other operation. At that point the conversion ops leave this builder and
 * become their own isolated transaction(s); the rest of this builder is unchanged.
 */
export function buildFusedCloseTx(
  sdkAccount: Account,
  input: FusedCloseInput,
  network: Network
): string {
  const ops = assembleFusedCloseOps(sdkAccount.accountId(), input);

  // The SDK multiplies the `fee` option by the operation count, so passing the
  // per-operation base fee yields a total of BASE_FEE_STROOPS * opCount on-chain.
  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASES[network],
  }).setTimeout(TX_TIMEOUT_SECONDS);

  // Memo only belongs on the merge-carrying transaction (direct destination).
  if (input.includeMerge && input.memo) {
    builder.addMemo(input.memoType === "id" ? Memo.id(input.memo) : Memo.text(input.memo));
  }

  for (const op of ops) builder.addOperation(op);
  return builder.build().toEnvelope().toXDR("base64");
}
