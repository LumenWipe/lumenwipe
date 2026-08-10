import { test, expect } from "bun:test";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";
import { getAccountState } from "@/lib/stellar/account";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

test(
  "getAccountState › reports a real sponsored trustline created on testnet",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const sponsor = Keypair.random();
    const sponsored = Keypair.random();
    const issuer = Keypair.random();

    await Promise.all([
      fund(sponsor.publicKey()),
      fund(sponsored.publicKey()),
      fund(issuer.publicKey()),
    ]);
    const asset = new Asset("LWTEST", issuer.publicKey());

    const sponsorAccount = await server.loadAccount(sponsor.publicKey());
    const tx = new TransactionBuilder(sponsorAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: sponsored.publicKey(),
          source: sponsor.publicKey(),
        })
      )
      .addOperation(Operation.changeTrust({ asset, source: sponsored.publicKey() }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: sponsored.publicKey() }))
      .setTimeout(60)
      .build();
    tx.sign(sponsor);
    tx.sign(sponsored);
    await server.submitTransaction(tx);

    // Horizon indexing lag for the account this test's assertions read through.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const state = await getAccountState(sponsor.publicKey(), "testnet");

    expect(state.numSponsoring).toBe(1);
    expect(state.sponsorshipEnumerationIncomplete).toBe(false);
    expect(state.sponsoredEntries).toContainEqual({
      kind: "trustline",
      owner: sponsored.publicKey(),
      asset: `LWTEST:${issuer.publicKey()}`,
    });
  },
  30000
);
