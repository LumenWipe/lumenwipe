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
  seededProtocols,
  sharedExpectation,
  verifyDemolishTransaction,
  type PlaygroundCloseExpectation,
} from "@/lib/verify";
import {
  PINNED_ASSETS,
  resolvePlan,
  SOROSWAP,
  XLM_SAC,
  type ScenarioSelection,
} from "@/lib/scenarios";

// The playground's structural check for a Soroban contract call (lib/verify-soroban.ts), and its
// place in front of the shared verifier (lib/verify.ts).

const demo = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
const ROUTER = PINNED_SOROBAN_PROTOCOLS.soroswap.entry[0]!;
const contractId = (): string => StrKey.encodeContract(randomBytes(32));
const PAIR = SOROSWAP.pair;
const [TOKEN_A, TOKEN_B] = SOROSWAP.tokens;

const SEEDED: SorobanExpectation = {
  demoPublic: demo,
  seeded: [{ protocol: "soroswap", variant: "lp" }],
};

const address = (a: string): xdr.ScVal => new Address(a).toScVal();
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

interface Removal {
  to?: string;
  aMin?: bigint;
  bMin?: bigint;
  tokenA?: string;
  tokenB?: string;
  liquidity?: bigint;
}

function removalArgs({
  to = demo,
  aMin = BigInt(5),
  bMin = BigInt(7),
  tokenA = TOKEN_A,
  tokenB = TOKEN_B,
  liquidity = BigInt(1000),
}: Removal = {}): xdr.ScVal[] {
  return [
    address(tokenA),
    address(tokenB),
    i128(liquidity),
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

  test("a contract the pinned row does not let a call be made to is refused", () => {
    expect(outcome(build(call({ contract: contractId() })))).toBe("soroban_contract_not_pinned");
    // The pair is in the router's family, so the authorization may reach it, but no call is made
    // to it directly.
    expect(outcome(build(call({ contract: PAIR })))).toBe("soroban_contract_not_pinned");
  });

  test("the tokens named must be exactly the pinned pair's, in either order", () => {
    const reversed = removalArgs({ tokenA: TOKEN_B, tokenB: TOKEN_A });
    expect(outcome(build(call({ args: reversed })))).toBe("accepted");
    expect(outcome(build(call({ args: removalArgs({ tokenB: contractId() }) })))).toBe(
      "soroban_token_not_pinned"
    );
    expect(outcome(build(call({ args: removalArgs({ tokenB: TOKEN_A }) })))).toBe(
      "soroban_token_not_pinned"
    );
    const account = removalArgs();
    account[0] = address(demo);
    expect(outcome(build(call({ args: account })))).toBe("soroban_token_not_pinned");
  });

  test("a liquidity amount that is not a positive i128 is refused", () => {
    expect(outcome(build(call({ args: removalArgs({ liquidity: BigInt(0) }) })))).toBe(
      "soroban_amount_not_positive"
    );
    const args = removalArgs();
    args[2] = nativeToScVal(BigInt(1000), { type: "u128" });
    expect(outcome(build(call({ args })))).toBe("soroban_amount_not_positive");
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

  const SOROSWAP_LP: ScenarioSelection = { scenarios: [{ id: "soroswap-lp", params: {} }] };

  function sessionExpectation(
    selection: ScenarioSelection = { scenarios: [{ id: "lwdemo-holding", params: {} }] }
  ): PlaygroundCloseExpectation {
    return expectationFromSession(
      {
        demoPublic: demo,
        ephemeralIssuers: [],
        recordedSigners: [],
        selection,
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

  test("a session whose selection seeds no protocol has every call refused by its Soroban module", () => {
    const expected = sessionExpectation();
    expect(expected.sorobanSeeded).toEqual([]);
    expect(demolishOutcome(build(call()), expected)).toBe("soroban:soroban_protocol_not_seeded");
    expect(demolishOutcome(build(call({ contract: contractId() })), expected)).toBe(
      "soroban:soroban_contract_not_pinned"
    );
  });

  test("a Soroswap liquidity session's exit passes both checks, alone in its transaction", () => {
    const expected = sessionExpectation(SOROSWAP_LP);
    expect(expected.sorobanSeeded).toEqual([{ protocol: "soroswap", variant: "lp" }]);
    expect(demolishOutcome(build(call()), expected)).toBe("accepted");
  });

  test("every transaction holding a contract call goes through the Soroban module first", () => {
    // Beside a merge, which the shared verifier would refuse for a reason of its own.
    const merge = Operation.accountMerge({ destination: sink });
    expect(demolishOutcome(build(call(), merge), sessionExpectation(SOROSWAP_LP))).toBe(
      "soroban:soroban_call_not_alone"
    );
    // A recipient the Soroban module refuses never reaches the shared verifier.
    expect(
      demolishOutcome(
        build(call({ args: removalArgs({ to: stranger }) })),
        sessionExpectation(SOROSWAP_LP)
      )
    ).toBe("soroban:soroban_account_argument_mismatch");
  });

  test("a call the Soroban module accepts still has to pass the shared verifier", () => {
    // The authorization moves a share other than the one the call removes: the playground's
    // module checks only that it stays in the router's family, the shared verifier that the router
    // pays exactly the removed amount into its pair.
    const auth = removalAuth(
      invocation(PAIR, "transfer", [address(demo), address(PAIR), i128(BigInt(999))])
    );
    expect(outcome(build(call({ auth: [auth] })))).toBe("accepted");
    expect(demolishOutcome(build(call({ auth: [auth] })), sessionExpectation(SOROSWAP_LP))).toBe(
      "shared:exit_liquidity_auth_invalid"
    );
  });
});

describe("the shared expectation, from the selection and the pinned configuration only", () => {
  const sink = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  const CIRCLE = PINNED_ASSETS["circle-usdc"];
  const lwdemoSac = new Asset("LWDEMO", issuer).contractId(Networks.TESTNET);

  const expectationFor = (...ids: ("soroswap-lp" | "lwdemo-holding")[]) =>
    expectationFromSession(
      {
        demoPublic: demo,
        ephemeralIssuers: [],
        recordedSigners: [],
        selection: { scenarios: ids.map((id) => ({ id, params: {} })) },
        transferRecipient: null,
        helperAccounts: [],
        claimableBalances: [],
      },
      sink,
      issuer
    );
  const withPool = sharedExpectation(expectationFor("lwdemo-holding", "soroswap-lp"));
  const without = sharedExpectation(expectationFor("lwdemo-holding"));

  test("the seeded protocols come from the plan's steps", () => {
    const steps = (ids: ScenarioSelection) => resolvePlan(ids).steps;
    expect(seededProtocols(steps({ scenarios: [{ id: "soroswap-lp", params: {} }] }))).toEqual([
      { protocol: "soroswap", variant: "lp" },
    ]);
    expect(seededProtocols(steps({ scenarios: [{ id: "lwdemo-holding", params: {} }] }))).toEqual(
      []
    );
  });

  test("the pinned asset is one of the session's assets, with its fixed issuer", () => {
    expect(expectationFor("soroswap-lp").assets).toEqual([
      { code: CIRCLE.code, issuer: CIRCLE.issuer },
    ]);
    expect(expectationFor("lwdemo-holding").assets).toEqual([{ code: "LWDEMO", issuer }]);
  });

  test("exitContracts: the router and the pair, only when the selection seeds the pool", () => {
    expect(withPool.exitContracts).toEqual([SOROSWAP.router, SOROSWAP.pair]);
    expect(without.exitContracts).toEqual([]);
  });

  test("exitFunctions: the router's removal, and none on the pair", () => {
    expect(withPool.exitFunctions).toEqual({
      [SOROSWAP.router]: ["remove_liquidity"],
      [SOROSWAP.pair]: [],
    });
    expect(without.exitFunctions).toEqual({});
  });

  test("positionTokenContracts: the pair's two tokens", () => {
    expect(withPool.positionTokenContracts).toEqual([CIRCLE.contract, XLM_SAC]);
    expect(without.positionTokenContracts).toEqual([]);
  });

  test("ownTokensByContract: the pair's tokens, keyed by the pair", () => {
    expect(withPool.ownTokensByContract).toEqual({ [SOROSWAP.pair]: [CIRCLE.contract, XLM_SAC] });
    expect(without.ownTokensByContract).toEqual({});
  });

  test("heldTokenContracts: XLM and the contract of every asset the session holds", () => {
    expect(withPool.heldTokenContracts).toEqual([XLM_SAC, lwdemoSac, CIRCLE.contract]);
    expect(without.heldTokenContracts).toEqual([XLM_SAC, lwdemoSac]);
  });

  test("protectedTokenContracts: the same list, so a spend of any is held to a repay", () => {
    expect(withPool.protectedTokenContracts).toEqual(withPool.heldTokenContracts);
    expect(without.protectedTokenContracts).toEqual(without.heldTokenContracts);
  });

  test("the fields no seeded protocol uses stay empty, and the registry is the bundled one", () => {
    for (const shared of [withPool, without]) {
      expect(shared.shareTokenContracts).toEqual([]);
      expect(shared.debtTokenContracts).toEqual([]);
      expect(shared.repayTokensByPool).toEqual({});
      expect(shared.registryContracts).toContain(SOROSWAP.router);
      expect(shared.registryContracts).not.toContain(SOROSWAP.pair);
    }
  });
});
