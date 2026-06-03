import { Keypair, TransactionBuilder, Operation, Asset, Account, Memo } from "@stellar/stellar-sdk";
import { getRpcServer } from "./rpc";
import { submitAndWait } from "./submit";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";

export interface EphemeralMediator {
  publicKey: string;
  signOnce: (xdr: string, network: Network) => string;
}

export function generateEphemeralKeypair(): EphemeralMediator {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  let secret: string | null = keypair.secret();

  return {
    publicKey,
    signOnce(xdr: string, network: Network): string {
      if (!secret) throw new Error("Mediator keypair already used.");
      const passphrase = NETWORK_PASSPHRASES[network];
      const tx = TransactionBuilder.fromXDR(xdr, passphrase);
      const kp = Keypair.fromSecret(secret);
      tx.sign(kp);
      secret = null;
      return tx.toEnvelope().toXDR("base64");
    },
  };
}

export interface MediatorFlowResult {
  mergeHash: string;
  forwardHash: string;
}

export async function executeMediatorFlow(
  mergeSignedXdr: string,
  mediator: EphemeralMediator,
  destinationAddress: string,
  memo: string | null,
  network: Network,
  onStatus?: (status: string) => void,
  memoType?: "text" | "id" | "hash" | null
): Promise<MediatorFlowResult> {
  const server = getRpcServer(network);
  const passphrase = NETWORK_PASSPHRASES[network];

  onStatus?.("Submitting account merge...");
  const { txHash: mergeHash } = await submitAndWait(mergeSignedXdr, network, onStatus);

  onStatus?.("Building forward transaction...");

  // Get mediator sequence number and balance.
  // The Soroban RPC's getAccount parses LedgerEntry XDR - if testnet runs a newer
  // protocol version than the SDK knows, this throws "Bad union switch: N".
  // Fall back to SE API (plain JSON, no XDR parsing) in that case.
  const { seGet } = await import("@/lib/se-api/client");
  interface SeAccountResp {
    sequence?: string;
    balances?: Array<{ asset_type: string; balance: string }>;
  }

  let mediatorSeq: string;
  let mediatorBalance = "1.5"; // conservative default
  let balanceFetched = false;

  try {
    const mediatorRpcAccount = await server.getAccount(mediator.publicKey);
    mediatorSeq = mediatorRpcAccount.sequenceNumber();
  } catch {
    // XDR parse error - fall back to SE API for both sequence and balance
    const acct = await seGet<SeAccountResp>(network, `/account/${mediator.publicKey}`);
    if (!acct.sequence) {
      throw new Error(
        "Could not retrieve mediator account sequence. Please retry from the beginning."
      );
    }
    mediatorSeq = acct.sequence;
    mediatorBalance =
      acct.balances?.find((b) => b.asset_type === "native")?.balance ?? mediatorBalance;
    balanceFetched = true;
  }

  if (!balanceFetched) {
    try {
      const resp = await seGet<SeAccountResp>(network, `/account/${mediator.publicKey}`);
      mediatorBalance =
        resp.balances?.find((b) => b.asset_type === "native")?.balance ?? mediatorBalance;
    } catch (err) {
      if (process.env.NODE_ENV !== "production")
        console.warn("[mediator] balance fetch failed, using default:", err);
    }
  }

  const sendAmount = (parseFloat(mediatorBalance) - 1.0).toFixed(7);
  if (parseFloat(sendAmount) <= 0) {
    throw new Error("Mediator has insufficient balance to forward funds.");
  }

  const sdkAccount = new Account(mediator.publicKey, mediatorSeq);
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

  builder.addOperation(
    Operation.payment({
      destination: destinationAddress,
      asset: Asset.native(),
      amount: sendAmount,
    })
  );

  const forwardTx = builder.build();
  const forwardXdr = forwardTx.toEnvelope().toXDR("base64");
  const signedForwardXdr = mediator.signOnce(forwardXdr, network);

  onStatus?.("Forwarding funds to destination...");
  const { txHash: forwardHash } = await submitAndWait(signedForwardXdr, network, onStatus);

  return { mergeHash, forwardHash };
}
