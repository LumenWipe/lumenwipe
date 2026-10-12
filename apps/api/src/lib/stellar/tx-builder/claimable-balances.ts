import { TransactionBuilder, Operation, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { ClaimableBalance } from "@lumenwipe/types";

export const TOO_MANY_CLAIMABLE_BALANCES_MESSAGE =
  "This account holds more claimable balances than a close can read at once, and the ones " +
  "left unclaimed fill that read, so the rest cannot be reached. It cannot be closed safely " +
  "until some of them are claimed.";

export function claimBalanceOps(balances: ClaimableBalance[]): xdr.Operation[] {
  return balances.map((b) => Operation.claimClaimableBalance({ balanceId: b.id }));
}

export function buildClaimBalancesTx(
  sdkAccount: Account,
  balances: ClaimableBalance[],
  network: Network
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  // Per-operation fee: TransactionBuilder multiplies this by the operation count itself, so
  // pre-multiplying here would double-count it (BASE_FEE_STROOPS * N passed in, then * N again
  // by the SDK, charging N^2 instead of N).
  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  for (const op of claimBalanceOps(balances)) {
    builder.addOperation(op);
  }

  return builder.build().toEnvelope().toXDR("base64");
}
