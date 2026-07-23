import { TransactionBuilder, Memo, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type {
  AccountSigner,
  ClaimableBalance,
  DataEntry,
  OpenOffer,
  Trustline,
} from "@/types/account";
import type { ConversionPath } from "@/types/plan";
import { signerNormalizationOps } from "./signers";
import { dataEntryRemovalOps } from "./data-entries";
import { offerCancellationOps } from "./offers";
import { assetConversionOp, issuerPaymentOp } from "./asset-conversion";
import { claimBalanceOps } from "./claimable-balances";
import { trustlineRemovalOps } from "./trustlines";
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
  claimableBalances: ClaimableBalance[];
  assetActions: AssetAction[];
  trustlines: Trustline[];
  destinationAddress: string;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  includeMerge: boolean;
}

/**
 * Assembles the ordered operation list for a fused close. Pure: account id and
 * input in, operation envelopes out, no network side effects. Exported so the
 * step engine can count operations before building, and so the assembly logic is
 * not duplicated. Order is fixed: signer normalization, data removal, offer
 * cancellation, claimable-balance claiming, per-asset disposition, trustline
 * removal, and (for direct destinations) the account merge - so by the time
 * accountMerge runs every subentry is already gone. Claiming runs before the
 * asset dispositions because a claim raises the held balance an action spends.
 */
export function assembleFusedCloseOps(masterKey: string, input: FusedCloseInput): xdr.Operation[] {
  const ops: xdr.Operation[] = [];
  if (input.needsSignerNormalization) ops.push(...signerNormalizationOps(input.signers, masterKey));
  ops.push(...dataEntryRemovalOps(input.dataEntries));
  ops.push(...offerCancellationOps(input.openOffers));
  ops.push(...claimBalanceOps(input.claimableBalances));
  for (const a of input.assetActions) {
    ops.push(
      a.action === "convert"
        ? assetConversionOp(masterKey, a.trustline, a.path)
        : issuerPaymentOp(a.trustline)
    );
  }
  ops.push(...trustlineRemovalOps(input.trustlines));
  if (input.includeMerge) ops.push(mergeOp(input.destinationAddress));
  return ops;
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
