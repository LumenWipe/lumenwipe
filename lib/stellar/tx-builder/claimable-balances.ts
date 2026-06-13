import { TransactionBuilder, Operation, Account } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { ClaimableBalance } from "@/types/account";

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

  for (const balance of balances) {
    builder.addOperation(Operation.claimClaimableBalance({ balanceId: balance.id }));
  }

  return builder.build().toEnvelope().toXDR("base64");
}
