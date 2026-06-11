import { TransactionBuilder, Operation, Asset, Memo, Account } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, STROOPS_PER_XLM, TX_TIMEOUT_SECONDS } from "@/config/constants";

export function buildMergeTx(
  sdkAccount: Account,
  destinationAddress: string,
  memo: string | null,
  network: Network,
  memoType?: "text" | "id" | "hash" | null
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  if (memo) {
    if (memoType === "id") {
      builder.addMemo(Memo.id(memo));
    } else {
      builder.addMemo(Memo.text(memo));
    }
  }

  builder.addOperation(Operation.accountMerge({ destination: destinationAddress }));

  return builder.build().toEnvelope().toXDR("base64");
}

/**
 * Builds the atomic exchange-merge transaction, routed through the shared
 * mediator account:
 *
 *   op0: accountMerge  source(user)     -> mediator
 *   op1: payment       source(mediator) -> destination (+ tx memo)
 *
 * The payment forwards essentially the entire balance (minus the two-operation
 * network fee), so the user recovers ~100% of their XLM, including the source
 * account's freed base reserve. The mediator's own base reserve is never
 * touched - it is funded once by the operator and reused for everyone.
 *
 * Returns unsigned XDR. The user signs their half (the merge / the envelope)
 * and the backend co-signs the mediator's payment leg.
 */
export function buildMediatorMergePaymentTx(
  sdkAccount: Account,
  mediatorPublicKey: string,
  destinationAddress: string,
  nativeBalanceLumens: string,
  memo: string | null,
  network: Network,
  memoType?: "text" | "id" | "hash" | null
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  // The only cost beyond the standard network fee: a two-operation fee buffer.
  const feeBuffer = (2 * BASE_FEE_STROOPS) / STROOPS_PER_XLM;
  const amount = (parseFloat(nativeBalanceLumens) - feeBuffer).toFixed(7);

  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  if (memo) {
    if (memoType === "id") {
      builder.addMemo(Memo.id(memo));
    } else {
      builder.addMemo(Memo.text(memo));
    }
  }

  builder.addOperation(Operation.accountMerge({ destination: mediatorPublicKey }));
  builder.addOperation(
    Operation.payment({
      source: mediatorPublicKey,
      destination: destinationAddress,
      asset: Asset.native(),
      amount,
    })
  );

  return builder.build().toEnvelope().toXDR("base64");
}
