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
  AQUARIUS,
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

describe("the Aquarius row", () => {
  const POOL = AQUARIUS.pool;
  const SHARE = AQUARIUS.shareToken;
  const AQUARIUS_SEEDED: SorobanExpectation = {
    demoPublic: demo,
    seeded: [{ protocol: "aquarius", variant: "lp" }],
  };
  const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });
  const floorsOf = (...floors: bigint[]): xdr.ScVal => xdr.ScVal.scvVec(floors.map(u128));

  interface Withdrawal {
    user?: string;
    shares?: bigint;
    floors?: xdr.ScVal;
  }

  /** `withdraw(user, share_amount, min_amounts)`, as apps/api/src/lib/defi-exits/aquarius.ts builds it. */
  const withdrawArgs = ({
    user = demo,
    shares = BigInt(1000),
    floors = floorsOf(BigInt(5), BigInt(7)),
  }: Withdrawal = {}): xdr.ScVal[] => [address(user), u128(shares), floors];

  /** The tree testnet returns for the exit: the pool call, and the demo's shares burned. */
  const withdrawalAuth = (
    sub: xdr.SorobanAuthorizedInvocation = invocation(SHARE, "burn", [
      address(demo),
      i128(BigInt(1000)),
    ])
  ): xdr.SorobanAuthorizationEntry =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: invocation(POOL, "withdraw", withdrawArgs(), [sub]),
    });

  const withdrawal = ({
    contract = POOL,
    fn = "withdraw",
    args = withdrawArgs(),
    auth = [withdrawalAuth()],
  }: CallOpts = {}): Transaction =>
    build(Operation.invokeContractFunction({ contract, function: fn, args, auth }));

  const aquariusOutcome = (tx: Transaction): string => outcome(tx, AQUARIUS_SEEDED);

  test("the row pins the pool as the call target and its share token as the only family", () => {
    expect(PINNED_SOROBAN_PROTOCOLS.aquarius.entry).toEqual([POOL]);
    expect(PINNED_SOROBAN_PROTOCOLS.aquarius.family).toEqual([SHARE]);
    expect(Object.keys(PINNED_SOROBAN_PROTOCOLS.aquarius.functions)).toEqual(["withdraw"]);
  });

  test("a withdraw for the demo, with a positive floor per pool token, is accepted", () => {
    expect(aquariusOutcome(withdrawal())).toBe("accepted");
  });

  test("a zero floor is refused, for either token", () => {
    for (const floors of [floorsOf(BigInt(0), BigInt(7)), floorsOf(BigInt(5), BigInt(0))]) {
      expect(aquariusOutcome(withdrawal({ args: withdrawArgs({ floors }) }))).toBe(
        "soroban_min_out_not_positive"
      );
    }
  });

  test("a floor that is not a u128 is refused", () => {
    const floors = xdr.ScVal.scvVec([i128(BigInt(5)), u128(BigInt(7))]);
    expect(aquariusOutcome(withdrawal({ args: withdrawArgs({ floors }) }))).toBe(
      "soroban_min_out_not_positive"
    );
  });

  test("a floor list of any other length, or not a list at all, is refused", () => {
    for (const floors of [
      floorsOf(BigInt(5), BigInt(7), BigInt(9)),
      floorsOf(BigInt(5)),
      floorsOf(),
      u128(BigInt(5)),
    ]) {
      expect(aquariusOutcome(withdrawal({ args: withdrawArgs({ floors }) }))).toBe(
        "soroban_min_out_vec_invalid"
      );
    }
  });

  test("a share amount that is not a positive u128 is refused", () => {
    expect(aquariusOutcome(withdrawal({ args: withdrawArgs({ shares: BigInt(0) }) }))).toBe(
      "soroban_amount_not_positive"
    );
    const args = withdrawArgs();
    args[1] = i128(BigInt(1000));
    expect(aquariusOutcome(withdrawal({ args }))).toBe("soroban_amount_not_positive");
  });

  test("a user other than the demo is refused", () => {
    for (const user of [stranger, POOL]) {
      expect(aquariusOutcome(withdrawal({ args: withdrawArgs({ user }) }))).toBe(
        "soroban_account_argument_mismatch"
      );
    }
  });

  test("a pool other than the pinned one is refused, as is a call to the share token", () => {
    expect(aquariusOutcome(withdrawal({ contract: contractId() }))).toBe(
      "soroban_contract_not_pinned"
    );
    expect(aquariusOutcome(withdrawal({ contract: SHARE }))).toBe("soroban_contract_not_pinned");
    // The router seeds the position but is never an exit's call target.
    expect(aquariusOutcome(withdrawal({ contract: AQUARIUS.router }))).toBe(
      "soroban_contract_not_pinned"
    );
  });

  test("a function other than withdraw is refused, the claim included", () => {
    expect(aquariusOutcome(withdrawal({ fn: "claim", args: [address(demo)] }))).toBe(
      "soroban_function_not_allowed"
    );
  });

  test("arguments of another shape are refused", () => {
    expect(aquariusOutcome(withdrawal({ args: withdrawArgs().slice(0, 2) }))).toBe(
      "soroban_arguments_invalid"
    );
  });

  test("a sub-invocation outside the pool and its share token is refused, at any depth", () => {
    const drain = invocation(AQUARIUS.tokens[0], "transfer", [
      address(demo),
      address(stranger),
      i128(BigInt(1)),
    ]);
    expect(aquariusOutcome(withdrawal({ auth: [withdrawalAuth(drain)] }))).toBe(
      "soroban_auth_outside_family"
    );
    const nested = invocation(SHARE, "burn", [address(demo), i128(BigInt(1000))], [drain]);
    expect(aquariusOutcome(withdrawal({ auth: [withdrawalAuth(nested)] }))).toBe(
      "soroban_auth_outside_family"
    );
    // Soroswap's pair is another protocol's family.
    const pair = invocation(SOROSWAP.pair, "transfer", [address(demo)]);
    expect(aquariusOutcome(withdrawal({ auth: [withdrawalAuth(pair)] }))).toBe(
      "soroban_auth_outside_family"
    );
  });

  test("the pool is refused for a session that seeds only the other pool", () => {
    expect(outcome(withdrawal())).toBe("soroban_protocol_not_seeded");
    // And the other pool's exit is refused for a session that seeds only this one.
    expect(aquariusOutcome(build(call()))).toBe("soroban_protocol_not_seeded");
  });

  describe("in front of the shared verifier", () => {
    const sink = Keypair.random().publicKey();
    const issuer = Keypair.random().publicKey();
    const expectationFor = (...ids: ("soroswap-lp" | "aquarius-lp")[]) =>
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

    test("an Aquarius session's exit passes both checks, alone in its transaction", () => {
      const expected = expectationFor("aquarius-lp");
      expect(expected.sorobanSeeded).toEqual([{ protocol: "aquarius", variant: "lp" }]);
      expect(demolishOutcome(withdrawal(), expected)).toBe("accepted");
    });

    test("with both pools seeded, each pool's exit passes both checks", () => {
      const expected = expectationFor("soroswap-lp", "aquarius-lp");
      expect(expected.sorobanSeeded).toEqual([
        { protocol: "soroswap", variant: "lp" },
        { protocol: "aquarius", variant: "lp" },
      ]);
      expect(demolishOutcome(withdrawal(), expected)).toBe("accepted");
      expect(demolishOutcome(build(call()), expected)).toBe("accepted");
    });

    test("the exit is refused beside a merge, and for a Soroswap-only session", () => {
      const merge = Operation.accountMerge({ destination: sink });
      const tx = build(
        Operation.invokeContractFunction({
          contract: POOL,
          function: "withdraw",
          args: withdrawArgs(),
          auth: [withdrawalAuth()],
        }),
        merge
      );
      expect(demolishOutcome(tx, expectationFor("aquarius-lp"))).toBe(
        "soroban:soroban_call_not_alone"
      );
      expect(demolishOutcome(withdrawal(), expectationFor("soroswap-lp"))).toBe(
        "soroban:soroban_protocol_not_seeded"
      );
    });
  });
});

describe("the Aquarius shared expectation, from the selection and the pinned configuration only", () => {
  const sink = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  const CIRCLE = PINNED_ASSETS["circle-usdc"];
  const shared = (...ids: ("soroswap-lp" | "aquarius-lp" | "lwdemo-holding")[]) =>
    sharedExpectation(
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
      )
    );
  const aquarius = shared("aquarius-lp");
  const both = shared("soroswap-lp", "aquarius-lp");
  const without = shared("lwdemo-holding");

  test("the seeded protocols come from the plan's steps, never from what ran", () => {
    const seeded = (...ids: ("soroswap-lp" | "aquarius-lp")[]) =>
      seededProtocols(resolvePlan({ scenarios: ids.map((id) => ({ id, params: {} })) }).steps);
    expect(seeded("aquarius-lp")).toEqual([{ protocol: "aquarius", variant: "lp" }]);
    expect(seeded("soroswap-lp")).toEqual([{ protocol: "soroswap", variant: "lp" }]);
    expect(seeded("soroswap-lp", "aquarius-lp")).toEqual([
      { protocol: "soroswap", variant: "lp" },
      { protocol: "aquarius", variant: "lp" },
    ]);
  });

  test("exitContracts: the pool alone, never the router or the share token", () => {
    expect(aquarius.exitContracts).toEqual([AQUARIUS.pool]);
    expect(both.exitContracts).toEqual([SOROSWAP.router, SOROSWAP.pair, AQUARIUS.pool]);
    expect(without.exitContracts).toEqual([]);
  });

  test("exitFunctions: the pool's withdraw, and nothing on the share token", () => {
    expect(aquarius.exitFunctions).toEqual({ [AQUARIUS.pool]: ["withdraw"] });
    expect(both.exitFunctions[AQUARIUS.pool]).toEqual(["withdraw"]);
    expect(Object.keys(both.exitFunctions)).not.toContain(AQUARIUS.shareToken);
  });

  test("positionTokenContracts: the pool's two tokens and its share token, each once", () => {
    expect(aquarius.positionTokenContracts).toEqual([
      CIRCLE.contract,
      XLM_SAC,
      AQUARIUS.shareToken,
    ]);
    expect(both.positionTokenContracts).toEqual([CIRCLE.contract, XLM_SAC, AQUARIUS.shareToken]);
  });

  test("ownTokensByContract: the pool's tokens and its share token, keyed by the pool", () => {
    expect(aquarius.ownTokensByContract).toEqual({
      [AQUARIUS.pool]: [CIRCLE.contract, XLM_SAC, AQUARIUS.shareToken],
    });
    expect(both.ownTokensByContract).toEqual({
      [SOROSWAP.pair]: [CIRCLE.contract, XLM_SAC],
      [AQUARIUS.pool]: [CIRCLE.contract, XLM_SAC, AQUARIUS.shareToken],
    });
  });

  test("shareTokenContracts: the share token, only when the selection seeds the pool", () => {
    expect(aquarius.shareTokenContracts).toEqual([AQUARIUS.shareToken]);
    expect(both.shareTokenContracts).toEqual([AQUARIUS.shareToken]);
    expect(shared("soroswap-lp").shareTokenContracts).toEqual([]);
    expect(without.shareTokenContracts).toEqual([]);
  });

  test("heldTokenContracts: XLM and the one USDC trustline both pools share", () => {
    expect(aquarius.heldTokenContracts).toEqual([XLM_SAC, CIRCLE.contract]);
    expect(both.heldTokenContracts).toEqual([XLM_SAC, CIRCLE.contract]);
    expect(both.protectedTokenContracts).toEqual(both.heldTokenContracts);
  });
});
