import { TransactionBuilder, Operation, Asset, Memo, Account } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, MEDIATOR_RESERVE_XLM, TX_TIMEOUT_SECONDS } from "@/config/constants";

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

export function buildFundMediatorTx(
  sdkAccount: Account,
  mediatorPublicKey: string,
  network: Network
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  builder.addOperation(
    Operation.createAccount({
      destination: mediatorPublicKey,
      startingBalance: String(MEDIATOR_RESERVE_XLM),
    })
  );

  return builder.build().toEnvelope().toXDR("base64");
}

export function buildMediatorMergeTx(
  sdkAccount: Account,
  mediatorAddress: string,
  network: Network
): string {
  const passphrase = NETWORK_PASSPHRASES[network];

  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: passphrase,
  }).setTimeout(TX_TIMEOUT_SECONDS);

  builder.addOperation(Operation.accountMerge({ destination: mediatorAddress }));

  return builder.build().toEnvelope().toXDR("base64");
}
