import { TransactionBuilder, Operation, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { ClaimableBalance } from "@/types/account";

export function claimBalanceOps(balances: ClaimableBalance[]): xdr.Operation[] {
  return balances.map((b) => Operation.claimClaimableBalance({ balanceId: b.id }));
}

export function buildClaimBalancesTx(
  sdkAccount: Account,
  balances: ClaimableBalance[],
  network: Network
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS * balances.length),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  for (const op of claimBalanceOps(balances)) {
    builder.addOperation(op);
  }

  return builder.build().toEnvelope().toXDR("base64");
}
