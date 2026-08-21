import { Keypair, Transaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { LumenWipeClient, runClose, type CloseEngineDeps, type CloseTransaction } from "@lumenwipe/sdk";
import { verifyDemolishTransaction } from "./verify";

export interface RunDemolishOptions {
  demoKeypair: Keypair;
  sinkPublic: string;
  apiUrl: string;
  apiKey: string;
  onConfirmed?: (txId: string, hash: string) => void;
}

/**
 * Drives the real close engine against the demo account. This is the actual
 * production `apps/api` close/transactions -> submit loop - the playground
 * supplies its own verify (structural check against the fixed sink account)
 * and sign (custodial, with the decrypted demo secret) instead of a browser
 * wallet.
 */
export async function runDemolish(opts: RunDemolishOptions): Promise<void> {
  const client = new LumenWipeClient({
    baseUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    network: "testnet",
  });
  const demoPublic = opts.demoKeypair.publicKey();

  const deps: CloseEngineDeps = {
    getTransactions: async () => {
      const res = await client.closeTransactions({ source: demoPublic, destination: opts.sinkPublic });
      return res;
    },
    verify: (tx: CloseTransaction) => {
      verifyDemolishTransaction(tx, { demoPublic, sinkPublic: opts.sinkPublic });
    },
    // The demo account is always single-sig from the master key's point of view:
    // ADD_SIGNER (mess step) only ever adds a co-signer, never raises the master
    // key's own weight requirement below what it already satisfies.
    requiredWeight: () => 1,
    sign: async (_tx, xdr) => {
      const parsed = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      if (!(parsed instanceof Transaction)) {
        throw new Error("Unexpected fee-bump transaction from the API");
      }
      parsed.sign(opts.demoKeypair);
      return { xdr: parsed.toEnvelope().toXDR("base64"), weight: 1 };
    },
    submit: async (_tx, xdr) => {
      const res = await client.submit(xdr);
      return res.hash;
    },
    onConfirmed: (tx, hash) => opts.onConfirmed?.(tx.id, hash),
  };

  await runClose(deps);
}
