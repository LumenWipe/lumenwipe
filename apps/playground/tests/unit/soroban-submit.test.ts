import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  Address,
  Keypair,
  Operation,
  rpc,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  MAX_SOROBAN_FEE_STROOPS,
  SorobanSubmitError,
  submitSoroban,
  type SorobanSubmitDeps,
} from "@/lib/soroban-submit";
import { contractCallOp, seedContractCall, type ContractCall } from "@/lib/soroban-seed";

// lib/soroban-submit.ts against a fake RPC: the simulation is untrusted, so what it returns is
// checked before the demo key signs, and nothing is sent after a refusal.

const source = Keypair.random();
const CONTRACT = StrKey.encodeContract(randomBytes(32));
const CALL: ContractCall = {
  contract: CONTRACT,
  function: "approve",
  args: [
    new Address(source.publicKey()).toScVal(),
    new Address(Keypair.random().publicKey()).toScVal(),
    nativeToScVal(BigInt(1), { type: "i128" }),
    nativeToScVal(1000, { type: "u32" }),
  ],
};

const invocationOf = (call: ContractCall): xdr.SorobanAuthorizedInvocation =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(call.contract).toScAddress(),
        functionName: call.function,
        args: call.args,
      })
    ),
    subInvocations: [],
  });

const sourceAuth = (call: ContractCall = CALL): xdr.SorobanAuthorizationEntry =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocationOf(call),
  });

/** A raw simulation answer, as the RPC returns one over JSON. */
const simulation = (
  auth: xdr.SorobanAuthorizationEntry[] = [sourceAuth()],
  minResourceFee = "50000"
): rpc.Api.RawSimulateTransactionResponse => ({
  id: "1",
  latestLedger: 100,
  transactionData: new SorobanDataBuilder().setResourceFee(minResourceFee).build().toXdr("base64"),
  minResourceFee,
  results: [{ auth: auth.map((a) => a.toXdr("base64")), xdr: xdr.ScVal.scvVoid().toXdr("base64") }],
  events: [],
});

type Sent = { status: string; hash: string; errorResult?: unknown };

interface Fake {
  deps: Partial<SorobanSubmitDeps>;
  sent: Transaction[];
  polls: number;
}

function fakeRpc({
  sim = simulation(),
  sends = [{ status: "PENDING" }] as Omit<Sent, "hash">[],
  results = ["NOT_FOUND", "SUCCESS"] as string[],
  assemble,
}: {
  sim?:
    rpc.Api.RawSimulateTransactionResponse | { error: string; id: string; latestLedger: number };
  sends?: Omit<Sent, "hash">[];
  results?: string[];
  assemble?: SorobanSubmitDeps["assemble"];
} = {}): Fake {
  let clock = 0;
  const fake: Fake = { deps: {}, sent: [], polls: 0 };
  const server = {
    simulateTransaction: async () => sim,
    sendTransaction: async (tx: Transaction) => {
      fake.sent.push(tx);
      const next = sends[Math.min(fake.sent.length - 1, sends.length - 1)];
      return { ...next, hash: Buffer.from(tx.hash()).toString("hex") };
    },
    getTransaction: async () => {
      const status = results[Math.min(fake.polls, results.length - 1)];
      fake.polls += 1;
      return { status };
    },
  } as unknown as SorobanSubmitDeps["rpc"];
  fake.deps = {
    loadSequence: async () => "41",
    rpc: server,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...(assemble ? { assemble } : {}),
  };
  return fake;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "submitted";
  } catch (err) {
    if (err instanceof SorobanSubmitError) return err.message;
    throw err;
  }
}

describe("submitSoroban", () => {
  test("a call that simulates, sends and confirms returns its hash, signed by the source", async () => {
    const fake = fakeRpc();
    const { txHash } = await submitSoroban(source, contractCallOp(CALL), fake.deps);
    expect(fake.sent).toHaveLength(1);
    const [tx] = fake.sent;
    expect(txHash).toBe(Buffer.from(tx.hash()).toString("hex"));
    expect(tx.source).toBe(source.publicKey());
    expect(tx.sequence).toBe("42");
    expect(tx.signatures).toHaveLength(1);
    expect(source.verify(tx.hash(), tx.signatures[0].signature)).toBe(true);
    // The resource fee comes from the simulation, on top of the classic fee.
    expect(BigInt(tx.fee)).toBe(BigInt(50_100));
  });

  test("seedContractCall goes through the same path", async () => {
    const fake = fakeRpc();
    await seedContractCall(source, CALL, fake.deps);
    expect(fake.sent).toHaveLength(1);
  });

  test("a transaction that fails on the ledger is an error, not a success", async () => {
    const fake = fakeRpc({ results: ["FAILED"] });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), fake.deps))).toStartWith(
      "transaction_failed"
    );
  });

  test("a transaction never seen within the timeout is an error", async () => {
    const fake = fakeRpc({ results: ["NOT_FOUND"] });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), fake.deps))).toStartWith(
      "transaction_timeout"
    );
    expect(fake.polls).toBeGreaterThan(10);
  });

  test("TRY_AGAIN_LATER is retried a bounded number of times", async () => {
    const recovers = fakeRpc({ sends: [{ status: "TRY_AGAIN_LATER" }, { status: "PENDING" }] });
    await submitSoroban(source, contractCallOp(CALL), recovers.deps);
    expect(recovers.sent).toHaveLength(2);

    const never = fakeRpc({ sends: [{ status: "TRY_AGAIN_LATER" }] });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), never.deps))).toBe(
      "send_try_again_later"
    );
    expect(never.sent).toHaveLength(3);
  });

  test("DUPLICATE is polled like PENDING, and ERROR is thrown", async () => {
    const dup = fakeRpc({ sends: [{ status: "DUPLICATE" }] });
    await submitSoroban(source, contractCallOp(CALL), dup.deps);
    expect(dup.polls).toBe(2);

    const rejected = fakeRpc({ sends: [{ status: "ERROR" }] });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), rejected.deps))).toStartWith(
      "send_rejected"
    );
    expect(rejected.polls).toBe(0);
  });

  test("a failed simulation is thrown before anything is sent", async () => {
    const fake = fakeRpc({ sim: { error: "HostError", id: "1", latestLedger: 100 } });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), fake.deps))).toStartWith(
      "simulation_failed"
    );
    expect(fake.sent).toHaveLength(0);
  });
});

describe("the simulation is held to the built call before signing", () => {
  test("an assembly that changes the host function is refused and never sent", async () => {
    const other: ContractCall = { ...CALL, function: "transfer" };
    const fake = fakeRpc({
      assemble: (tx) =>
        TransactionBuilder.cloneFrom(tx, { fee: "100" })
          .clearOperations()
          .addOperation(contractCallOp(other))
          .build(),
    });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), fake.deps))).toBe(
      "assembled_host_function_changed"
    );
    expect(fake.sent).toHaveLength(0);
  });

  test("an authorization entry with address credentials is refused and never sent", async () => {
    const addressAuth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(source.publicKey()).toScAddress(),
          nonce: BigInt(7),
          signatureExpirationLedger: 200,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: invocationOf(CALL),
    });
    const fake = fakeRpc({ sim: simulation([sourceAuth(), addressAuth]) });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), fake.deps))).toBe(
      "auth_credentials_not_source"
    );
    expect(fake.sent).toHaveLength(0);
  });

  test("an authorization entry rooted at another call is refused and never sent", async () => {
    const other: ContractCall = { ...CALL, contract: StrKey.encodeContract(randomBytes(32)) };
    const fake = fakeRpc({ sim: simulation([sourceAuth(other)]) });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), fake.deps))).toBe(
      "auth_root_not_the_call"
    );
    expect(fake.sent).toHaveLength(0);
  });

  test("a fee above the cap is refused and never sent; one at the cap is sent", async () => {
    const over = (MAX_SOROBAN_FEE_STROOPS - BigInt(99)).toString();
    const fake = fakeRpc({ sim: simulation(undefined, over) });
    expect(await refusal(submitSoroban(source, contractCallOp(CALL), fake.deps))).toBe(
      "fee_above_cap"
    );
    expect(fake.sent).toHaveLength(0);

    const atCap = fakeRpc({
      sim: simulation(undefined, (MAX_SOROBAN_FEE_STROOPS - BigInt(100)).toString()),
    });
    await submitSoroban(source, contractCallOp(CALL), atCap.deps);
    expect(BigInt(atCap.sent[0].fee)).toBe(MAX_SOROBAN_FEE_STROOPS);
  });

  test("a host function that is not a contract call is refused and never sent", async () => {
    const fake = fakeRpc();
    const upload = Operation.uploadContractWasm({ wasm: new Uint8Array([0, 97, 115, 109]) });
    expect(await refusal(submitSoroban(source, upload, fake.deps))).toBe(
      "host_function_not_contract_call"
    );
    expect(fake.sent).toHaveLength(0);
  });
});
