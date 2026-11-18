import { describe, expect, test } from "bun:test";
import {
  Account,
  Address,
  hash,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { VerificationError, verifyCloseTransaction } from "@lumenwipe/verify";
import type { CloseTransaction, DecisionPoint } from "@lumenwipe/sdk";
import { buildDemolishDecisions, planAnswers } from "@/lib/demolish";
import { executeMessStep, type MessContext } from "@/lib/mess-builders";
import type { ContractCall } from "@/lib/soroban-seed";
import {
  PLAYGROUND_TOKEN,
  PLAYGROUND_TOKEN_SEED,
  resolvePlan,
  type MessStepDef,
  type ScenarioSelection,
} from "@/lib/scenarios";
import { contractIdFor } from "@/lib/token-deploy";
import {
  expectationFromSession,
  sharedExpectation,
  verifyDemolishTransaction,
  type PlaygroundCloseExpectation,
} from "@/lib/verify";
import {
  assertSorobanTransaction,
  PINNED_SOROBAN_PROTOCOLS,
  SorobanVerificationError,
  type SorobanExpectation,
} from "@/lib/verify-soroban";

// The Soroban token scenario: the token's pinned address, the admin's mint, the playground's own
// check of the transfer back (lib/verify-soroban.ts) in front of the shared verifier, and the
// answers the close gives the API for it.

const demo = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const sink = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const TOKEN = PLAYGROUND_TOKEN.contract;
const ADMIN = PLAYGROUND_TOKEN.admin;
const MINTED = BigInt(PLAYGROUND_TOKEN_SEED.amount) * BigInt(10_000_000);

const TRANSFER = 0;
const RESIDUE = 1;

const selectionOf = (disposition: number, ...more: ScenarioSelection["scenarios"]) => ({
  scenarios: [{ id: "soroban-token" as const, params: { disposition } }, ...more],
});

const expectationFor = (disposition: number, ...more: ScenarioSelection["scenarios"]) =>
  expectationFromSession(
    {
      demoPublic: demo,
      ephemeralIssuers: [],
      recordedSigners: [],
      selection: selectionOf(disposition, ...more),
      transferRecipient: null,
      helperAccounts: [],
      claimableBalances: [],
    },
    sink,
    issuer,
    null
  );

const address = (a: string): xdr.ScVal => new Address(a).toScVal();
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

const invocation = (
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = []
): xdr.SorobanAuthorizedInvocation =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      })
    ),
    subInvocations,
  });

interface TransferOpts {
  from?: string;
  to?: string;
  amount?: xdr.ScVal;
  fn?: string;
  contract?: string;
  subs?: xdr.SorobanAuthorizedInvocation[];
  credentials?: xdr.SorobanCredentials;
  args?: xdr.ScVal[];
}

/** `transfer(from, to, amount)` on the token, authorizing itself alone, as the API builds it. */
function transfer({
  from = demo,
  to = ADMIN,
  amount = i128(MINTED),
  fn = "transfer",
  contract = TOKEN,
  subs = [],
  credentials = xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
  args = [address(from), address(to), amount],
}: TransferOpts = {}): xdr.Operation {
  return Operation.invokeContractFunction({
    contract,
    function: fn,
    args,
    auth: [
      new xdr.SorobanAuthorizationEntry({
        credentials,
        rootInvocation: invocation(contract, fn, args, subs),
      }),
    ],
  });
}

function build(...ops: xdr.Operation[]): Transaction {
  const builder = new TransactionBuilder(new Account(demo, "1"), {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);
  return builder.setTimeout(60).build();
}

const SENDS_BACK: SorobanExpectation = {
  demoPublic: demo,
  seeded: [{ protocol: "playground-token", variant: "transfer" }],
};

function outcome(tx: Transaction, expected: SorobanExpectation = SENDS_BACK): string {
  try {
    assertSorobanTransaction(tx, expected);
    return "accepted";
  } catch (err) {
    if (err instanceof SorobanVerificationError) return err.message;
    throw err;
  }
}

function demolishOutcome(tx: Transaction, expected: PlaygroundCloseExpectation): string {
  const close: CloseTransaction = {
    id: "t1",
    order: 0,
    dependsOn: [],
    xdr: tx.toXDR(),
    networkPassphrase: Networks.TESTNET,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers: [],
    intent: {
      summary: "test fixture",
      source: demo,
      fee: tx.fee,
      memo: null,
      memoType: null,
      guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
      operations: [],
    },
  };
  try {
    verifyDemolishTransaction(close, expected);
    return "accepted";
  } catch (err) {
    if (err instanceof SorobanVerificationError) return `soroban:${err.message}`;
    if (err instanceof VerificationError) return `shared:${err.code}`;
    throw err;
  }
}

function sharedOutcome(tx: Transaction, expected: PlaygroundCloseExpectation): string {
  try {
    verifyCloseTransaction({
      unsignedXdr: tx.toXDR(),
      network: "testnet",
      expected: sharedExpectation(expected),
    });
    return "accepted";
  } catch (err) {
    if (err instanceof VerificationError) return err.code;
    throw err;
  }
}

describe("the pinned token", () => {
  test("its address is the one its admin and salt derive on testnet, before it exists", () => {
    expect(contractIdFor(ADMIN, PLAYGROUND_TOKEN.salt, Networks.TESTNET)).toBe(TOKEN);
    expect<string>(PLAYGROUND_TOKEN.salt).toBe(
      Buffer.from(hash(Buffer.from("lumenwipe/playground-token/v1"))).toString("hex")
    );
    // Each input moves it: another deployer, another salt, another network.
    const otherSalt = Buffer.from(hash(Buffer.from("another salt"))).toString("hex");
    expect(contractIdFor(stranger, PLAYGROUND_TOKEN.salt, Networks.TESTNET)).not.toBe(TOKEN);
    expect(contractIdFor(ADMIN, otherSalt, Networks.TESTNET)).not.toBe(TOKEN);
    expect(contractIdFor(ADMIN, PLAYGROUND_TOKEN.salt, Networks.PUBLIC)).not.toBe(TOKEN);
    expect(StrKey.isValidEd25519PublicKey(ADMIN)).toBe(true);
  });
});

describe("the admin's mint", () => {
  const admin = Keypair.random();
  const demoKey = Keypair.random();
  const ctx = (tokenAdmin: Keypair | null): MessContext => ({
    demo: demoKey,
    ephemeralIssuers: new Map(),
    persistentIssuer: Keypair.random(),
    mmPublic: Keypair.random().publicKey(),
    transferRecipient: null,
    helpers: new Map(),
    recordSigner: async () => {},
    recordClaimableBalances: async () => {},
    allowances: [],
    recordAllowance: async () => {},
    tokenAdmin,
  });
  const mintStep = (disposition: number): MessStepDef =>
    resolvePlan(selectionOf(disposition)).steps.find((s) => s.id === "MINT_TOKEN")!;

  test("the admin mints the seeded amount to the demo, and the demo signs nothing", async () => {
    for (const disposition of [TRANSFER, RESIDUE]) {
      const calls: [string, ContractCall][] = [];
      const hashOut = await executeMessStep(mintStep(disposition), ctx(admin), {
        contractCall: async (source, call) => {
          calls.push([source.publicKey(), call]);
          return { txHash: "f".repeat(64) };
        },
      });
      expect(hashOut).toBe("f".repeat(64));
      expect(calls).toHaveLength(1);
      const [signer, call] = calls[0]!;
      expect(signer).toBe(admin.publicKey());
      expect([call.contract, call.function]).toEqual([TOKEN, "mint"]);
      expect(call.args.map((a) => scValToNative(a) as unknown)).toEqual([
        demoKey.publicKey(),
        MINTED,
      ]);
      expect(call.args[1]?.type).toBe("scvI128");
    }
  });

  test("without the admin's key, nothing is sent", async () => {
    let sent = 0;
    const run = executeMessStep(mintStep(TRANSFER), ctx(null), {
      contractCall: async () => {
        sent++;
        return { txHash: "f".repeat(64) };
      },
    });
    await expect(run).rejects.toThrow("admin key is not configured");
    expect(sent).toBe(0);
  });

  test("a mint whose sequence another session took is sent again, at most three times", async () => {
    const attempts = (failures: string[]) => {
      const log = { sent: 0, slept: [] as number[] };
      const deps = {
        contractCall: async () => {
          const failure = failures[log.sent++];
          if (failure) throw new Error(failure);
          return { txHash: "e".repeat(64) };
        },
        sleep: async (ms: number) => {
          log.slept.push(ms);
        },
      };
      return { log, run: executeMessStep(mintStep(TRANSFER), ctx(admin), deps) };
    };
    const twice = attempts(["send_rejected: txBadSeq", "send_rejected: txBadSeq"]);
    expect(await twice.run).toBe("e".repeat(64));
    expect(twice.log).toEqual({ sent: 3, slept: [2_000, 4_000] });

    const always = attempts(Array(5).fill("send_rejected: txBadSeq"));
    await expect(always.run).rejects.toThrow("send_rejected: txBadSeq");
    expect(always.log.sent).toBe(3);

    // Any other failure may have landed, or will fail the same way: it is never sent again.
    const other = attempts(["transaction_timeout: abc"]);
    await expect(other.run).rejects.toThrow("transaction_timeout");
    expect(other.log.sent).toBe(1);
  });
});

describe("the playground token row", () => {
  test("pins the token alone, its plain transfer, and no sub-invocation", () => {
    const row = PINNED_SOROBAN_PROTOCOLS["playground-token"];
    expect(row.entry).toEqual([TOKEN]);
    expect(row.family).toEqual([]);
    expect(row.subInvocations).toBe(false);
    expect(Object.keys(row.functions)).toEqual(["transfer"]);
    expect(row.functions.transfer?.recipientArgs).toEqual({ at: [1], address: ADMIN });
  });

  test("a transfer of the demo's balance back to the pinned admin is accepted", () => {
    expect(outcome(build(transfer()))).toBe("accepted");
    expect(outcome(build(transfer({ amount: i128(BigInt(1)) })))).toBe("accepted");
  });

  test("a transfer to any address but the pinned admin is refused", () => {
    for (const to of [stranger, demo, sink, issuer]) {
      expect(outcome(build(transfer({ to })))).toBe("soroban_recipient_not_pinned");
    }
    expect(outcome(build(transfer({ to: StrKey.encodeContract(Buffer.alloc(32, 7)) })))).toBe(
      "soroban_recipient_not_pinned"
    );
  });

  test("an authorization that reaches below the transfer is refused, even into the token", () => {
    const self = invocation(TOKEN, "transfer", [address(demo), address(ADMIN), i128(MINTED)]);
    const elsewhere = invocation(StrKey.encodeContract(Buffer.alloc(32, 9)), "transfer", []);
    expect(outcome(build(transfer({ subs: [self] })))).toBe("soroban_auth_sub_invocation");
    expect(outcome(build(transfer({ subs: [elsewhere] })))).toBe("soroban_auth_sub_invocation");
  });

  test("a balance other than the demo's own is refused", () => {
    expect(outcome(build(transfer({ from: stranger })))).toBe("soroban_account_argument_mismatch");
  });

  test("an amount that is not a positive i128 is refused", () => {
    expect(outcome(build(transfer({ amount: i128(BigInt(0)) })))).toBe(
      "soroban_amount_not_positive"
    );
    expect(outcome(build(transfer({ amount: i128(BigInt(-5)) })))).toBe(
      "soroban_amount_not_positive"
    );
    const u128 = nativeToScVal(MINTED, { type: "u128" });
    expect(outcome(build(transfer({ amount: u128 })))).toBe("soroban_amount_not_positive");
  });

  test("any function but transfer is refused, the admin's own included", () => {
    for (const fn of ["transfer_from", "burn", "approve", "mint", "set_admin", "initialize"]) {
      expect(outcome(build(transfer({ fn })))).toBe("soroban_function_not_allowed");
    }
  });

  test("arguments of another shape are refused", () => {
    const args = [address(demo), address(ADMIN), i128(MINTED), xdr.ScVal.scvVoid()];
    expect(outcome(build(transfer({ args })))).toBe("soroban_arguments_invalid");
  });

  test("an authorization signed by an address rather than the transaction is refused", () => {
    const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(demo).toScAddress(),
        nonce: BigInt(1),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      })
    );
    expect(outcome(build(transfer({ credentials })))).toBe("soroban_auth_credentials_not_source");
  });

  test("a session that leaves the token, or seeds another protocol only, makes no call to it", () => {
    expect(outcome(build(transfer()), { demoPublic: demo, seeded: [] })).toBe(
      "soroban_protocol_not_seeded"
    );
    const phoenix: SorobanExpectation = {
      demoPublic: demo,
      seeded: [{ protocol: "phoenix", variant: "lp" }],
    };
    expect(outcome(build(transfer()), phoenix)).toBe("soroban_protocol_not_seeded");
  });
});

describe("in front of the shared verifier", () => {
  test("the selection's disposition, the admin and the minted amount fill the expectation", () => {
    const sends = expectationFor(TRANSFER);
    expect(sends.token).toEqual({
      contract: TOKEN,
      disposition: "transfer",
      destination: ADMIN,
      amount: MINTED.toString(),
    });
    expect(sends.sorobanSeeded).toEqual([{ protocol: "playground-token", variant: "transfer" }]);
    const leaves = expectationFor(RESIDUE);
    expect(leaves.token?.disposition).toBe("residue");
    expect(leaves.sorobanSeeded).toEqual([]);
  });

  test("the shared verifier is told the transfer only when the session sends it back", () => {
    expect(sharedExpectation(expectationFor(TRANSFER)).tokenTransfers).toEqual({
      [TOKEN]: { destination: ADMIN, amount: MINTED.toString() },
    });
    expect(sharedExpectation(expectationFor(RESIDUE)).tokenTransfers).toEqual({});
  });

  test("the token is a held balance in either variant, so no exit may move it", () => {
    for (const disposition of [TRANSFER, RESIDUE]) {
      const shared = sharedExpectation(expectationFor(disposition));
      expect(shared.heldTokenContracts).toContain(TOKEN);
      expect(shared.protectedTokenContracts).not.toContain(TOKEN);
    }
  });

  test("the transfer back passes both checks, alone in its transaction", () => {
    expect(demolishOutcome(build(transfer()), expectationFor(TRANSFER))).toBe("accepted");
  });

  test("a session that leaves the token has the transfer refused by both checks", () => {
    expect(demolishOutcome(build(transfer()), expectationFor(RESIDUE))).toBe(
      "soroban:soroban_protocol_not_seeded"
    );
    expect(sharedOutcome(build(transfer()), expectationFor(RESIDUE))).not.toBe("accepted");
  });

  test("the shared verifier alone refuses another destination and less than the minted amount", () => {
    const sends = expectationFor(TRANSFER);
    expect(sharedOutcome(build(transfer({ to: stranger })), sends)).toBe(
      "transfer_destination_mismatch"
    );
    expect(sharedOutcome(build(transfer({ amount: i128(MINTED - BigInt(1)) })), sends)).toBe(
      "transfer_amount_short"
    );
    expect(demolishOutcome(build(transfer({ amount: i128(MINTED - BigInt(1)) })), sends)).toBe(
      "shared:transfer_amount_short"
    );
  });

  test("the transfer is refused beside a merge", () => {
    const tx = build(transfer(), Operation.accountMerge({ destination: sink }));
    expect(demolishOutcome(tx, expectationFor(TRANSFER))).toBe("soroban:soroban_call_not_alone");
  });
});

describe("the close's answers", () => {
  const tokenPoint = (contract: string, id = `token:${contract}`): DecisionPoint => ({
    id,
    type: "asset_disposition",
    subject: { kind: "soroban_token", contract, balance: MINTED.toString(), convertible: false },
    options: [{ id: "transfer_to_account" }, { id: "acknowledge_residue" }],
    default: "transfer_to_account",
    required: true,
  });
  const answerTo = (expected: PlaygroundCloseExpectation, point: DecisionPoint) =>
    buildDemolishDecisions([point], expected).answers.find((a) => a.id === point.id);

  test("the plan is asked with the token named, so the API's read looks for it", () => {
    for (const disposition of [TRANSFER, RESIDUE]) {
      expect(planAnswers(expectationFor(disposition))).toContainEqual({
        id: `token:${TOKEN}`,
        choice: "discovered",
      });
    }
    const none = expectationFor(TRANSFER);
    expect(planAnswers({ ...none, token: null }).some((a) => a.id.startsWith("token:"))).toBe(
      false
    );
  });

  test("a session that sends it back answers a transfer to the configured admin", () => {
    expect(answerTo(expectationFor(TRANSFER), tokenPoint(TOKEN))).toEqual({
      id: `token:${TOKEN}`,
      choice: "transfer_to_account",
      params: { destination: ADMIN },
    });
  });

  test("a session that leaves it acknowledges the residue", () => {
    expect(answerTo(expectationFor(RESIDUE), tokenPoint(TOKEN))).toEqual({
      id: `token:${TOKEN}`,
      choice: "acknowledge_residue",
    });
  });

  test("any other token, or a point whose id names another one, is left with the address", () => {
    const sends = expectationFor(TRANSFER);
    const other = StrKey.encodeContract(Buffer.alloc(32, 3));
    expect(answerTo(sends, tokenPoint(other))?.choice).toBe("acknowledge_residue");
    expect(answerTo(sends, tokenPoint(TOKEN, `token:${other}`))?.choice).toBe(
      "acknowledge_residue"
    );
  });
});
