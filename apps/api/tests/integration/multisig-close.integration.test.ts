// Must stay the first import, exactly as in src/main.ts - see sponsorship.integration.test.ts
// for the full rationale (config/networks.ts reads process.env at import time).
import "@/env";
import { test, expect } from "bun:test";
import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { getAccountState } from "@/lib/stellar/account-state";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

async function accountExists(server: Horizon.Server, id: string): Promise<boolean> {
  try {
    await server.loadAccount(id);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!RUN_INTEGRATION)(
  "a real 2-of-3 multisig account is closed end to end: one signer alone is rejected, two meet threshold and merge",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const master = Keypair.random(); // the account being closed - also signer #1
    const coSignerB = Keypair.random(); // signer #2
    const coSignerC = Keypair.random(); // signer #3, deliberately never used

    const destination = Keypair.random();

    await Promise.all([fund(master.publicKey()), fund(destination.publicKey())]);

    // Configure into 2-of-3: add two co-signers at weight 1 each, then raise every
    // threshold category to 2 so ACCOUNT_MERGE (a high-threshold op) genuinely needs two
    // of the three weight-1 keys - matches the epic's "2-of-3" acceptance criterion.
    const masterAccount = await server.loadAccount(master.publicKey());
    const configureTx = new TransactionBuilder(masterAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: coSignerB.publicKey(), weight: 1 } })
      )
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: coSignerC.publicKey(), weight: 1 } })
      )
      .addOperation(Operation.setOptions({ lowThreshold: 1, medThreshold: 2, highThreshold: 2 }))
      .setTimeout(60)
      .build();
    configureTx.sign(master);
    await server.submitTransaction(configureTx);

    // This is the function under test: confirms account-state reading surfaces the real
    // multisig signer set and thresholds this close will need to satisfy.
    const accountState = await getAccountState(master.publicKey(), "testnet");
    expect(accountState.signers).toHaveLength(3);
    expect(accountState.thresholds).toEqual({ low: 1, med: 2, high: 2 });

    // This is the function under test: builds the real close transaction(s) against live
    // state. A fresh account with no subentries/balances beyond XLM closes as a single
    // fused merge transaction.
    const result = await buildCloseTransactions(
      accountState,
      destination.publicKey(),
      {},
      "testnet",
      null,
      {}
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.requiresAnotherCall).toBe(false);
    const unsignedXdr = result.transactions[0].xdr;

    // One signer alone (weight 1) must NOT meet the high threshold (2) - proves this is a
    // genuine 2-of-3 account on-chain, not accidentally satisfiable by one key.
    const oneSigTx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    oneSigTx.sign(master);
    await expect(server.submitTransaction(oneSigTx)).rejects.toThrow();
    expect(await accountExists(server, master.publicKey())).toBe(true);

    // A second signer (co-signer B) brings accumulated weight to 2, meeting the threshold -
    // submit succeeds and the account is gone (merged).
    const twoSigTx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    twoSigTx.sign(master);
    twoSigTx.sign(coSignerB);
    const submitResult = await server.submitTransaction(twoSigTx);
    expect(submitResult.successful).toBe(true);

    expect(await accountExists(server, master.publicKey())).toBe(false);
  },
  90000
);
