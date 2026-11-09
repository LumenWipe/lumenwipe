import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { VerificationError } from "@lumenwipe/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";
import {
  assertSorobanTransaction,
  PINNED_SOROBAN_PROTOCOLS,
  SorobanVerificationError,
  type SorobanExpectation,
} from "@/lib/verify-soroban";
import {
  expectationFromSession,
  PLAYGROUND_CLOSE_OPERATION_TYPES,
  verifyDemolishTransaction,
  type PlaygroundCloseExpectation,
} from "@/lib/verify";

// The playground's structural check for a Soroban contract call (lib/verify-soroban.ts), and its
// place in front of the shared verifier (lib/verify.ts).

const demo = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const ROUTER = PINNED_SOROBAN_PROTOCOLS.soroswap.contracts[0];
const contractId = (): string => StrKey.encodeContract(randomBytes(32));
const PAIR = contractId();
const TOKEN_A = contractId();
const TOKEN_B = contractId();

const SEEDED: SorobanExpectation = {
  demoPublic: demo,
  seeded: [{ protocol: "soroswap", instances: [PAIR, TOKEN_A, TOKEN_B] }],
};

const address = (a: string): xdr.ScVal => new Address(a).toScVal();
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

interface Removal {
  to?: string;
  aMin?: bigint;
  bMin?: bigint;
}

function removalArgs({ to = demo, aMin = BigInt(5), bMin = BigInt(7) }: Removal = {}): xdr.ScVal[] {
  return [
    address(TOKEN_A),
    address(TOKEN_B),
    i128(BigInt(1000)),
    i128(aMin),
    i128(bMin),
    address(to),
    nativeToScVal(BigInt(1_800_000_000), { type: "u64" }),
  ];
}

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

/** The tree a Soroswap removal authorizes: the router call, and the LP share it moves to the pair. */
function removalAuth(
  sub: xdr.SorobanAuthorizedInvocation = invocation(PAIR, "transfer", [
    address(demo),
    address(PAIR),
    i128(BigInt(1000)),
  ]),
  credentials: xdr.SorobanCredentials = xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: invocation(ROUTER, "remove_liquidity", removalArgs(), [sub]),
  });
}

interface CallOpts {
  contract?: string;
  fn?: string;
  args?: xdr.ScVal[];
  auth?: xdr.SorobanAuthorizationEntry[];
  source?: string;
}

const call = ({
  contract = ROUTER,
  fn = "remove_liquidity",
  args = removalArgs(),
  auth = [removalAuth()],
  source,
}: CallOpts = {}): xdr.Operation =>
  Operation.invokeContractFunction({ contract, function: fn, args, auth, source });

function build(...ops: xdr.Operation[]): Transaction {
  const builder = new TransactionBuilder(new Account(demo, "1"), {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);
  return builder.setTimeout(60).build();
}

function outcome(tx: Transaction, expected: SorobanExpectation = SEEDED): string {
  try {
    assertSorobanTransaction(tx, expected);
    return "accepted";
  } catch (err) {
    if (err instanceof SorobanVerificationError) return err.message;
    throw err;
  }
}

describe("assertSorobanTransaction", () => {
  test("a Soroswap remove_liquidity to the demo, with positive floors, is accepted", () => {
    expect(outcome(build(call()))).toBe("accepted");
  });

  test("a contract that is neither pinned nor seeded by the session is refused", () => {
    expect(outcome(build(call({ contract: contractId() })))).toBe("soroban_contract_not_pinned");
  });

  test("a function outside the protocol's allowlist is refused", () => {
    expect(outcome(build(call({ fn: "swap_exact_tokens_for_tokens" })))).toBe(
      "soroban_function_not_allowed"
    );
    // An inherited property name is not an allowlisted function either.
    expect(outcome(build(call({ fn: "constructor" })))).toBe("soroban_function_not_allowed");
  });

  test("a recipient other than the demo is refused", () => {
    expect(outcome(build(call({ args: removalArgs({ to: stranger }) })))).toBe(
      "soroban_account_argument_mismatch"
    );
    expect(outcome(build(call({ args: removalArgs({ to: PAIR }) })))).toBe(
      "soroban_account_argument_mismatch"
    );
  });

  test("a zero minimum-out is refused, on either side", () => {
    expect(outcome(build(call({ args: removalArgs({ aMin: BigInt(0) }) })))).toBe(
      "soroban_min_out_not_positive"
    );
    expect(outcome(build(call({ args: removalArgs({ bMin: BigInt(0) }) })))).toBe(
      "soroban_min_out_not_positive"
    );
    expect(outcome(build(call({ args: removalArgs({ bMin: BigInt(-1) }) })))).toBe(
      "soroban_min_out_not_positive"
    );
  });

  test("a minimum-out that is not an i128 is refused", () => {
    const args = removalArgs();
    args[3] = nativeToScVal(BigInt(5), { type: "u64" });
    expect(outcome(build(call({ args })))).toBe("soroban_min_out_not_positive");
  });

  test("arguments of another shape are refused", () => {
    expect(outcome(build(call({ args: removalArgs().slice(0, 6) })))).toBe(
      "soroban_arguments_invalid"
    );
  });

  test("a call that is not alone in its transaction is refused", () => {
    expect(outcome(build(call(), call()))).toBe("soroban_call_not_alone");
    const withBump = build(call(), Operation.bumpSequence({ bumpTo: "2" }));
    expect(outcome(withBump)).toBe("soroban_call_not_alone");
  });

  test("a call acting for an account other than the demo is refused", () => {
    expect(outcome(build(call({ source: stranger })))).toBe("soroban_source_mismatch");
  });

  test("creating or uploading a contract is refused", () => {
    const create = Operation.createStellarAssetContract({ asset: Asset.native() });
    expect(outcome(build(create))).toBe("soroban_host_function_not_allowed");
    const upload = Operation.uploadContractWasm({ wasm: new Uint8Array([0, 97, 115, 109]) });
    expect(outcome(build(upload))).toBe("soroban_host_function_not_allowed");
  });

  test("an authorized sub-invocation outside the protocol's family is refused", () => {
    const drain = invocation(contractId(), "transfer", [
      address(demo),
      address(stranger),
      i128(BigInt(1)),
    ]);
    expect(outcome(build(call({ auth: [removalAuth(drain)] })))).toBe(
      "soroban_auth_outside_family"
    );
    // One level deeper is walked too.
    const nested = invocation(PAIR, "transfer", [address(demo)], [drain]);
    expect(outcome(build(call({ auth: [removalAuth(nested)] })))).toBe(
      "soroban_auth_outside_family"
    );
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
    expect(outcome(build(call({ auth: [removalAuth(undefined, credentials)] })))).toBe(
      "soroban_auth_credentials_not_source"
    );
  });

  test("a pinned protocol the session did not seed is refused", () => {
    expect(outcome(build(call()), { demoPublic: demo, seeded: [] })).toBe(
      "soroban_protocol_not_seeded"
    );
  });
});

describe("in front of the shared verifier", () => {
  const sink = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();

  function sessionExpectation(): PlaygroundCloseExpectation {
    return expectationFromSession(
      {
        demoPublic: demo,
        ephemeralIssuers: [],
        recordedSigners: [],
        selection: { scenarios: [{ id: "lwdemo-holding", params: {} }] },
        transferRecipient: null,
        helperAccounts: [],
        claimableBalances: [],
      },
      sink,
      issuer
    );
  }

  const closeTx = (tx: Transaction): CloseTransaction => ({
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
  });

  function demolishOutcome(tx: Transaction, expected: PlaygroundCloseExpectation): string {
    try {
      verifyDemolishTransaction(closeTx(tx), expected);
      return "accepted";
    } catch (err) {
      if (err instanceof SorobanVerificationError) return `soroban:${err.message}`;
      if (err instanceof VerificationError) return `shared:${err.code}`;
      throw err;
    }
  }

  test("invokeHostFunction is a playground close operation type", () => {
    expect(PLAYGROUND_CLOSE_OPERATION_TYPES).toContain("invokeHostFunction");
  });

  test("a current session seeds no protocol, so its Soroban module refuses every call", () => {
    const expected = sessionExpectation();
    expect(expected.sorobanSeeded).toEqual([]);
    expect(demolishOutcome(build(call()), expected)).toBe("soroban:soroban_protocol_not_seeded");
    expect(demolishOutcome(build(call({ contract: contractId() })), expected)).toBe(
      "soroban:soroban_contract_not_pinned"
    );
  });

  test("every transaction holding a contract call goes through the Soroban module first", () => {
    // Beside a merge, which the shared verifier would refuse for a reason of its own.
    const merge = Operation.accountMerge({ destination: sink });
    expect(demolishOutcome(build(call(), merge), sessionExpectation())).toBe(
      "soroban:soroban_call_not_alone"
    );
  });

  test("a call the Soroban module accepts still has to pass the shared verifier, which refuses it today", () => {
    // The shared expectation names no exit contract until a seeding scenario fills it (#432).
    const expected = { ...sessionExpectation(), sorobanSeeded: [...SEEDED.seeded] };
    expect(outcome(build(call()))).toBe("accepted");
    expect(demolishOutcome(build(call()), expected)).toBe("shared:exit_contract_not_position");
  });
});
