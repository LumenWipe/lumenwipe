/**
 * Test-only setup for `phoenix-exit-adapter.integration.test.ts`: opens a real LP (and partially
 * staked) position on the project's own reference Phoenix pool (see contract-registry.json's
 * phoenix/pool entry, initialized with a custom admin-mintable token as token_a and native XLM as
 * token_b), so the test can exit a fixture it generated itself rather than depend on some
 * pre-seeded account's position.
 */
import {
  Account,
  Address,
  Contract,
  Horizon,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as stellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { getRpcServer } from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";

export const PHOENIX_POOL = "CCVEHSVGFYL5SKLO3BSRZCWRHDWKVB5KX6LYT66GX6QNCRJEPYHF6FIV";
export const PHOENIX_STAKE = "CCELNFRXYUDJ5545AM7KIMHDHII5PQEGDVYHA3HSR7HXWUNH67EWBFXP";
/** The pool's token_a: a fresh, admin-mintable SEP-41 test token (not a classic-asset SAC, so no
 *  trustline is ever needed to receive it back). */
export const PHOENIX_TOKEN_A = "CDI3UIVKFNJAFBWOUMWQ6AO34BQ5JMFBHG4EUB3ZVKCKH5FINXE6QGGZ";
/** token_b: the native XLM Stellar Asset Contract. */
export const PHOENIX_TOKEN_B = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const BASE_FEE = "1000000";
const TX_TIMEOUT_SECONDS = 60;
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const i128Val = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

async function buildSignSubmit(source: Keypair, op: xdr.Operation): Promise<void> {
  const rpc = getRpcServer("testnet");
  const horizon = new Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(source.publicKey());
  const tx = new TransactionBuilder(new Account(account.accountId(), account.sequenceNumber()), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASES.testnet,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  const simulation = await rpc.simulateTransaction(tx);
  if (!stellarRpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`phoenix setup simulation failed: ${JSON.stringify(simulation)}`);
  }
  const assembled = stellarRpc.assembleTransaction(tx, simulation).build();
  assembled.sign(source);
  await submitAndWait(assembled.toXDR(), "testnet");
}

/** Mints `amount` of the pool's token_a to `to` - only the token's own admin can call this. */
export async function mintPhoenixTokenA(
  tokenAdmin: Keypair,
  to: string,
  amount: bigint
): Promise<void> {
  const op = new Contract(PHOENIX_TOKEN_A).call("mint", new Address(to).toScVal(), i128Val(amount));
  await buildSignSubmit(tokenAdmin, op);
}

/** Deposits both sides at a 1:1 ratio (the pool's own first-deposit-friendly default) and returns
 *  the minted LP shares. */
export async function providePhoenixLiquidity(
  account: Keypair,
  desiredA: bigint,
  desiredB: bigint
): Promise<void> {
  const sender = new Address(account.publicKey()).toScVal();
  // An Option<T> argument is the bare value for Some, or scvVoid for None - not an enum wrapper
  // (confirmed the hard way against the CLI's own arg parser before writing this).
  const op = new Contract(PHOENIX_POOL).call(
    "provide_liquidity",
    sender,
    i128Val(desiredA),
    i128Val(1n),
    i128Val(desiredB),
    i128Val(1n),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVoid()
  );
  await buildSignSubmit(account, op);
}

/** Bonds `amount` of the account's plain LP shares into the pool's stake contract. */
export async function bondPhoenixShares(account: Keypair, amount: bigint): Promise<void> {
  const op = new Contract(PHOENIX_STAKE).call(
    "bond",
    new Address(account.publicKey()).toScVal(),
    i128Val(amount)
  );
  await buildSignSubmit(account, op);
}
