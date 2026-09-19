/**
 * The conversion round holds a Soroswap-built swap to the one shape a conversion may have. The
 * transactions here are built the way the API builds them - a router call with a path, or an
 * aggregator call with a distribution, each with the authorization tree the signature would
 * satisfy - so every refusal below is a real deviation from that shape.
 */
import { describe, expect, test } from "bun:test";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Memo,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { SupportedPlatforms, TradeType, type QuoteResponse } from "@soroswap/sdk";
import {
  SWAP_FUNCTION,
  assertConversionShape,
  buildTokenConversionRound,
  type ExpectedConversion,
} from "@/lib/close-api/token-conversion-round";
import { XBULL_SWAP_FUNCTION } from "@/lib/close-api/xbull-conversion-round";
import { xlmContractId, type ConversionSdk } from "@/lib/soroswap/conversion-quotes";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { rawSimulation } from "./fixtures/fake-exit-adapter";
import xbullFixture from "../fixtures/xbull-strict-send-sample.json";

const ACCOUNT = Keypair.random().publicKey();
const OTHER_ACCOUNT = Keypair.random().publicKey();
const TOKEN = Address.contract(Buffer.alloc(32, 1)).toString();
const XLM = xlmContractId("mainnet");
// The registry's mainnet Soroswap contracts, and one pair the route passes through.
const AGGREGATOR = "CAYP3UWLJM7ZPTUKL6R6BFGTRWLZ46LRKOXTERI2K6BIJAWGYY62TXTO";
const ADAPTER = "CC6KQUATUBCIFZRDJL5X5PHCYGOHLPHKZQPUOTZTQTASGU5AUQ6DS7SC";
const ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
// The registry's mainnet router hash: the round resolves the live hash against the registry.
const ROUTER_HASH_LIVE = "4c3db3ebd2d6a2ab23de1f622eaabb39501539b4611b68622ec4e47f76c4ba07";
const PAIR = Address.contract(Buffer.alloc(32, 9)).toString();
const STRANGER_PAIR = Address.contract(Buffer.alloc(32, 10)).toString();
const STRANGER = Address.contract(Buffer.alloc(32, 8)).toString();
const ALLOWED = { aggregator: [AGGREGATOR], adapters: [ADAPTER], routers: [ROUTER] };
// The real mainnet xBull router the fixture's own contractArgsXDR was captured from
// (`xbull-strict-send-sample.json`'s `decoded.contractAddress`).
const XBULL_ROUTER = xbullFixture.decoded.contractAddress;
const NOW = 1_700_000_000;
const SEQUENCE = "100";
const BALANCE = 100_000_000n;
const FLOOR = 520_000_000n;

const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
const u64 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u64" });
const vec = (items: xdr.ScVal[]): xdr.ScVal => xdr.ScVal.scvVec(items);

function invocation(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = []
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      })
    ),
    subInvocations: subs,
  });
}

const transferLeaf = (to = PAIR, amount = BALANCE, from = ACCOUNT) =>
  invocation(TOKEN, "transfer", [addr(from), addr(to), i128(amount)]);

interface SwapShape {
  form: "router" | "aggregator";
  amountIn?: bigint;
  minOut?: bigint;
  to?: string;
  deadline?: bigint;
  path?: string[];
  tokenIn?: string;
  tokenOut?: string;
  tree?: (rootArgs: xdr.ScVal[]) => xdr.SorobanAuthorizedInvocation[];
  credentials?: xdr.SorobanCredentials;
  memo?: Memo;
  fee?: string;
  sequence?: string;
  source?: string;
  contract?: string;
  fn?: string;
  extraOp?: boolean;
  maxTime?: number;
  noAuth?: boolean;
}

/** A swap as the Soroswap API builds one, with every knob a test may turn. */
function swapTx(shape: SwapShape): Transaction {
  const amountIn = shape.amountIn ?? BALANCE;
  const minOut = shape.minOut ?? FLOOR;
  const to = shape.to ?? ACCOUNT;
  const deadline = shape.deadline ?? BigInt(NOW + 600);
  const contract = shape.contract ?? (shape.form === "router" ? ROUTER : AGGREGATOR);
  const args =
    shape.form === "router"
      ? [
          i128(amountIn),
          i128(minOut),
          vec((shape.path ?? [TOKEN, XLM]).map(addr)),
          addr(to),
          u64(deadline),
        ]
      : [
          addr(shape.tokenIn ?? TOKEN),
          addr(shape.tokenOut ?? XLM),
          i128(amountIn),
          i128(minOut),
          vec([]),
          addr(to),
          u64(deadline),
        ];
  const defaultTree = (): xdr.SorobanAuthorizedInvocation[] =>
    shape.form === "router"
      ? [transferLeaf()]
      : [
          invocation(
            ADAPTER,
            "swap",
            [],
            [invocation(ROUTER, SWAP_FUNCTION, [], [transferLeaf()])]
          ),
        ];
  const root = invocation(
    contract,
    shape.fn ?? SWAP_FUNCTION,
    args,
    (shape.tree ?? defaultTree)(args)
  );
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: shape.credentials ?? xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
  const op = new Contract(contract).call(shape.fn ?? SWAP_FUNCTION, ...args);
  // The SDK's Contract.call carries no auth; rebuild the operation with the entry attached.
  const withAuth = xdr.Operation.fromXDR(op.toXDR());
  withAuth
    .body()
    .invokeHostFunctionOp()
    .auth(shape.noAuth ? [] : [auth]);
  const builder = new TransactionBuilder(
    new Account(shape.source ?? ACCOUNT, shape.sequence ?? SEQUENCE),
    {
      fee: shape.fee ?? "52485",
      networkPassphrase: Networks.PUBLIC,
      memo: shape.memo,
    }
  )
    .addOperation(withAuth)
    .setTimebounds(0, shape.maxTime ?? NOW + 3600)
    .setSorobanData(new SorobanDataBuilder().setResourceFee(50_000n).build());
  if (shape.extraOp) builder.addOperation(new Contract(TOKEN).call("balance", addr(ACCOUNT)));
  return builder.build();
}

const expected = (over: Partial<ExpectedConversion> = {}): ExpectedConversion => ({
  token: TOKEN,
  account: ACCOUNT,
  xlm: XLM,
  amountIn: BALANCE,
  minOut: FLOOR,
  allowed: ALLOWED,
  sequence: SEQUENCE,
  nowSeconds: NOW,
  ...over,
});

describe("assertConversionShape", () => {
  test("accepts the two shapes the API builds: a router call with a path, an aggregator call through adapters", () => {
    expect(() => assertConversionShape(swapTx({ form: "router" }), expected())).not.toThrow();
    expect(() => assertConversionShape(swapTx({ form: "aggregator" }), expected())).not.toThrow();
    // A minimum above the floor, and a route split into two transfers that add up, are fine.
    expect(() =>
      assertConversionShape(swapTx({ form: "router", minOut: FLOOR + 1n }), expected())
    ).not.toThrow();
    expect(() =>
      assertConversionShape(
        swapTx({
          form: "router",
          tree: () => [transferLeaf(PAIR, BALANCE / 2n), transferLeaf(STRANGER_PAIR, BALANCE / 2n)],
        }),
        expected()
      )
    ).not.toThrow();
  });

  const refusals: Array<[string, SwapShape, RegExp]> = [
    [
      "another account's transaction",
      { form: "router", source: OTHER_ACCOUNT },
      /not this account's/,
    ],
    ["the wrong sequence", { form: "router", sequence: "200" }, /next transaction/],
    ["a memo", { form: "router", memo: Memo.text("hi") }, /memo/],
    ["an outsized fee", { form: "router", fee: "20000000" }, /fee exceeds/],
    ["an expiry too close", { form: "router", maxTime: NOW + 10 }, /expires/],
    ["a second operation", { form: "router", extraOp: true }, /one operation/],
    [
      "a contract outside the registry",
      { form: "router", contract: STRANGER },
      /aggregator or router/,
    ],
    [
      "another function",
      { form: "router", fn: "remove_liquidity" },
      /not swap_exact_tokens_for_tokens/,
    ],
    // The dangerous lookalike: swap_tokens_for_exact_tokens takes the same seven arguments with
    // the two amounts swapped (amount_out, amount_in_max), so reading them as an exact-in swap
    // would hold the wrong figures to the balance and the floor. The name is what stops it.
    [
      "the exact-out sibling, whose arguments would otherwise read as an exact-in swap",
      { form: "aggregator", fn: "swap_tokens_for_exact_tokens" },
      /not swap_exact_tokens_for_tokens/,
    ],
    ["less than the live balance", { form: "router", amountIn: BALANCE - 1n }, /amount_in/],
    ["a minimum under the floor", { form: "router", minOut: FLOOR - 1n }, /below your floor/],
    [
      "a route into something other than XLM",
      { form: "router", path: [TOKEN, STRANGER] },
      /token to XLM/,
    ],
    ["a route from another token", { form: "router", path: [STRANGER, XLM] }, /token to XLM/],
    ["paying another account", { form: "router", to: OTHER_ACCOUNT }, /does not pay this account/],
    ["a passed deadline", { form: "router", deadline: BigInt(NOW - 1) }, /deadline/],
    // A deadline in the future but inside the signing buffer: still refused, matching the same
    // 60-second buffer the transaction's own timeBounds are held to - a swap offered for signing
    // that the contract would already refuse by the time it is actually signed is not usable.
    [
      "a deadline too close to leave time to sign",
      { form: "router", deadline: BigInt(NOW + 30) },
      /deadline/,
    ],
    [
      "the aggregator swapping another token",
      { form: "aggregator", tokenIn: STRANGER },
      /token_in/,
    ],
    [
      "the aggregator buying another token",
      { form: "aggregator", tokenOut: STRANGER },
      /token_out/,
    ],
    [
      "foreign credentials",
      {
        form: "router",
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(ACCOUNT).toScAddress(),
            nonce: new xdr.Int64(1),
            signatureExpirationLedger: 1,
            signature: xdr.ScVal.scvVoid(),
          })
        ),
      },
      /credentials other than/,
    ],
    [
      "a transfer to a Stellar account hidden in the tree",
      { form: "router", tree: () => [transferLeaf(OTHER_ACCOUNT)] },
      /Stellar account, not a pool/,
    ],
    [
      "a transfer of someone else's balance",
      { form: "router", tree: () => [transferLeaf(PAIR, BALANCE, OTHER_ACCOUNT)] },
      /other than this account's/,
    ],
    [
      "the tree moving more than the swap spends",
      { form: "router", tree: () => [transferLeaf(PAIR, BALANCE), transferLeaf(PAIR, 1n)] },
      /more of the token leave/,
    ],
    [
      "a call on a contract no swap needs",
      { form: "router", tree: () => [invocation(STRANGER, "transfer", [])] },
      /no swap needs/,
    ],
    [
      "something other than transfer on the token",
      {
        form: "router",
        tree: () => [invocation(TOKEN, "approve", [addr(ACCOUNT), addr(PAIR), i128(1n), u64(1n)])],
      },
      /authorize approve on the token/,
    ],
    [
      "another account named in a nested argument",
      {
        form: "router",
        tree: () => [invocation(ROUTER, SWAP_FUNCTION, [addr(OTHER_ACCOUNT)], [transferLeaf()])],
      },
      /account other than the one being closed/,
    ],
    [
      "a tree deeper than any route",
      {
        form: "aggregator",
        tree: () => [
          invocation(
            ADAPTER,
            "swap",
            [],
            [
              invocation(
                ROUTER,
                SWAP_FUNCTION,
                [],
                [
                  invocation(
                    ROUTER,
                    SWAP_FUNCTION,
                    [],
                    [invocation(ROUTER, SWAP_FUNCTION, [], [transferLeaf()])]
                  ),
                ]
              ),
            ]
          ),
        ],
      },
      /deeper than a swap/,
    ],
    ["no authorization at all", { form: "router", noAuth: true }, /no authorization/],
  ];
  for (const [what, shape, message] of refusals) {
    test(`refuses ${what}`, () => {
      expect(() => assertConversionShape(swapTx(shape), expected())).toThrow(message);
    });
  }
});

// ─── the round ───────────────────────────────────────────────────────────────

function account(balance: string, over: Partial<AccountState> = {}): AccountState {
  return {
    address: ACCOUNT,
    network: "mainnet",
    sequence: SEQUENCE,
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: ACCOUNT, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(ACCOUNT),
    defiPositionsWarnings: [],
    sorobanTokens: {
      tokens: [{ contract: TOKEN, balance, symbol: "TKN", decimals: 7, sources: ["explorer"] }],
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
    ...over,
  };
}

function instanceEntry(contract: string, hashHex: string): rpc.Api.LedgerEntryResult {
  const key = new Contract(contract).getFootprint();
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hashHex, "hex")),
          storage: null,
        })
      ),
    })
  );
  return { key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 };
}

function quoteFor(amountIn: bigint, amountOut: bigint): QuoteResponse {
  return {
    assetIn: TOKEN,
    amountIn,
    assetOut: XLM,
    amountOut,
    otherAmountThreshold: amountOut,
    priceImpactPct: "0.02",
    platform: SupportedPlatforms.AGGREGATOR,
    routePlan: [
      { swapInfo: { protocol: "soroswap" as never, path: [TOKEN, XLM] }, percent: "100" },
    ],
    tradeType: TradeType.EXACT_IN,
    rawTrade: { amountIn, amountOutMin: amountOut, distribution: [] },
  } as QuoteResponse;
}

interface RoundWorld {
  balance: bigint | null;
  /** XLM out the API quotes for the balance; null = no route. */
  quotedOut: bigint | null;
  /** What the API builds; defaults to a sound router swap at the quoted floor. */
  built?: (quote: QuoteResponse) => Transaction | null;
  /** The code hash the ledger reports for the called contract. */
  liveHash?: string;
  /** When true, Soroswap's own quote/build stubs throw instead of running - proves a token
   *  pinned to another provider never touches Soroswap. */
  forbidSoroswap?: boolean;
  /** xBull's own fetch stub, serving both `/swaps/quote` and `/swaps/strict-send`; `null` (the
   *  default) means xBull is unreachable, matching every pre-existing test never entering that
   *  branch at all. */
  xbullFetch?: typeof fetch | null;
  /** The router(s) the xBull dispatch may call; defaults to the fixture's own real router. */
  xbullRouterAllowed?: string[];
  /** Authorization entries xBull's own simulation reports; empty unless set. */
  xbullAuth?: string[];
  xbullResourceFee?: string;
  /** Resolves xBull's opaque path indices to asset addresses; throws by default so a test that
   *  reaches it without configuring one fails loudly instead of silently returning nonsense. */
  xbullResolvePath?: (contractArgsXDR: string) => Promise<string[]>;
}

function roundDeps(world: RoundWorld) {
  const sdk: ConversionSdk = {
    async quote() {
      if (world.quotedOut === null) throw new Error("No path found");
      return quoteFor(world.balance ?? 0n, world.quotedOut);
    },
    async build({ quote }) {
      const q = quote as QuoteResponse;
      const min = (BigInt(q.amountOut) * 9950n) / 10_000n;
      const tx = world.built
        ? world.built(q)
        : swapTx({ form: "router", amountIn: BigInt(q.amountIn), minOut: min });
      return { xdr: tx ? tx.toXDR() : "", action: "swap", description: "" };
    },
  };
  const forbiddenSdk: ConversionSdk = {
    async quote() {
      throw new Error("Soroswap must not be consulted for a token pinned to another provider");
    },
    async build() {
      throw new Error("Soroswap must not be consulted for a token pinned to another provider");
    },
  };
  return {
    rpc: {
      async simulateTransaction() {
        if (world.balance === null) return rawSimulation("error", [], "0");
        const base = rawSimulation("ok", [], "100") as unknown as Record<string, unknown>;
        return {
          ...base,
          results: [
            { auth: [], xdr: nativeToScVal(world.balance, { type: "i128" }).toXDR("base64") },
          ],
        } as unknown as rpc.Api.SimulateTransactionResponse;
      },
      async getLedgerEntries(...keys: xdr.LedgerKey[]) {
        const contract = Address.fromScAddress(keys[0]!.contractData().contract()).toString();
        return {
          latestLedger: 1,
          entries: [instanceEntry(contract, world.liveHash ?? ROUTER_HASH_LIVE)],
        } as unknown as rpc.Api.GetLedgerEntriesResponse;
      },
    } as never,
    conversion: { sdk: world.forbidSoroswap ? forbiddenSdk : sdk, now: () => NOW * 1000 },
    allowed: () => ALLOWED,
    xbull: {
      rpc: {
        async simulateTransaction() {
          return rawSimulation("ok", world.xbullAuth ?? [], world.xbullResourceFee ?? "0");
        },
      } as never,
      xbull: {
        fetch: world.xbullFetch ?? null,
        baseUrl: "https://swap-api.xbull.io",
        now: () => NOW * 1000,
      },
      resolvePath:
        world.xbullResolvePath ??
        (async () => {
          throw new Error("resolvePath should not be called in this test");
        }),
    },
    xbullAllowed: () => ({ router: world.xbullRouterAllowed ?? [XBULL_ROUTER] }),
  };
}

const run = (
  state: AccountState,
  floors: Record<string, string | { minAmountOut: string; provider: "soroswap" | "xbull" }>,
  world: RoundWorld
) =>
  buildTokenConversionRound(
    state,
    { [TOKEN]: "convert" },
    Object.fromEntries(
      Object.entries(floors).map(([contract, value]) => [
        contract,
        typeof value === "string" ? { minAmountOut: value, provider: "soroswap" as const } : value,
      ])
    ),
    "mainnet",
    SEQUENCE,
    5_000,
    roundDeps(world)
  );

describe("the token conversion round", () => {
  test("nothing due: no token answered convert, or the answered one has moved", async () => {
    expect(
      await buildTokenConversionRound(
        account("5"),
        { [TOKEN]: "leave" },
        {},
        "mainnet",
        SEQUENCE,
        5_000,
        roundDeps({ balance: 5n, quotedOut: 1n })
      )
    ).toBeNull();
    expect(await run(account("5"), { [TOKEN]: "1" }, { balance: 0n, quotedOut: 1n })).toBeNull();
  });

  test("a missing floor, an unreadable balance, and a lost route are each named", async () => {
    await expect(run(account("5"), {}, { balance: 5n, quotedOut: 1n })).rejects.toMatchObject({
      code: "conversion_floor_missing",
    });
    await expect(
      run(account("5"), { [TOKEN]: "1" }, { balance: null, quotedOut: 1n })
    ).rejects.toMatchObject({
      code: "soroban_token_unreadable",
    });
    await expect(
      run(account("5"), { [TOKEN]: "1" }, { balance: 5n, quotedOut: null })
    ).rejects.toMatchObject({
      code: "soroban_token_route_lost",
    });
  });

  test("a sound build is offered as the round's transaction, decoded and summarized", async () => {
    const round = await run(
      account(BALANCE.toString()),
      { [TOKEN]: FLOOR.toString() },
      {
        balance: BALANCE,
        quotedOut: 524_963_090n,
      }
    );
    expect(round).not.toBeNull();
    expect(round!.transaction.covers).toEqual(["HANDLE_ASSETS"]);
    expect(round!.transaction.sourceSequence).toBe(SEQUENCE);
    expect(round!.remainingSteps).toBe(0);
    expect(round!.transaction.intent.summary).toBe(
      "Exchange 10 TKN for at least 52 XLM through Soroswap"
    );
    const op = round!.transaction.intent.operations[0]!;
    expect(op.type).toBe("invoke_host_function");
    if (op.type === "invoke_host_function") {
      expect(op.contract).toBe(ROUTER);
      expect(op.function).toBe(SWAP_FUNCTION);
      expect(op.accountsReferenced).toEqual([ACCOUNT]);
      expect(op.authDepth).toBe(1);
    }
  });

  test("a build whose shape deviates, or whose contract runs other code than the registry verified, is refused", async () => {
    const diverted = run(
      account(BALANCE.toString()),
      { [TOKEN]: FLOOR.toString() },
      {
        balance: BALANCE,
        quotedOut: 524_963_090n,
        // minOut set to clear the round's own fresh-quote floor (the same 9950/10000 the default
        // build applies), so the deviation under test - the destination - is what trips the check.
        built: (q) =>
          swapTx({
            form: "router",
            amountIn: BigInt(q.amountIn),
            minOut: (BigInt(q.amountOut) * 9950n) / 10_000n,
            to: OTHER_ACCOUNT,
          }),
      }
    );
    await expect(diverted).rejects.toMatchObject({ code: "soroban_token_conversion_unsafe" });
    await expect(diverted).rejects.toThrow(/does not pay this account/);

    const otherCode = run(
      account(BALANCE.toString()),
      { [TOKEN]: FLOOR.toString() },
      {
        balance: BALANCE,
        quotedOut: 524_963_090n,
        liveHash: "00".repeat(32),
      }
    );
    await expect(otherCode).rejects.toMatchObject({ code: "soroban_token_conversion_unsafe" });
    await expect(otherCode).rejects.toThrow(/not the code the registry verified/);

    const empty = run(
      account(BALANCE.toString()),
      { [TOKEN]: FLOOR.toString() },
      {
        balance: BALANCE,
        quotedOut: 524_963_090n,
        built: () => null,
      }
    );
    await expect(empty).rejects.toMatchObject({ code: "soroban_token_conversion_failed" });
  });

  test("a fresh quote whose floor falls under the one agreed to is a drift, with both figures", async () => {
    const promise = run(
      account(BALANCE.toString()),
      { [TOKEN]: FLOOR.toString() },
      {
        balance: BALANCE,
        quotedOut: 521_000_000n, // floor under slippage: 518,395,000 < 520,000,000
      }
    );
    await expect(promise).rejects.toMatchObject({ code: "quote_drifted" });
    await expect(promise).rejects.toThrow(/51\.8395 XLM, below the 52 XLM you agreed to/);
  });

  /** Serves `/swaps/quote` and `/swaps/strict-send` from one stub, the way `defaultXBullConversionDeps`
   *  wires a single `fetch` to both call sites (the round's quote call and `buildXBullConversion`'s
   *  build call). `/swaps/quote` echoes the caller's own requested amount back as `fromAmount` so
   *  the quote always clears `quoteTokenToXlmViaXBull`'s `quotedIn !== amountIn` check regardless
   *  of which balance a given test uses. */
  function xbullFetchStub(toAmount: string, contractArgsXDR: string | null): typeof fetch {
    return (async (input: string | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === "/swaps/quote") {
        return new Response(
          JSON.stringify({
            route: "route-1",
            fromAsset: TOKEN,
            toAsset: XLM,
            fromAmount: url.searchParams.get("amount"),
            toAmount,
            fee: { platformFee: "0", referralsFee: "0" },
          }),
          { status: 200 }
        );
      }
      if (url.pathname === "/swaps/strict-send") {
        return new Response(JSON.stringify({ contractArgsXDR }), {
          status: contractArgsXDR ? 200 : 400,
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  /** A bare `strict_send` root authorization, with no sub-invocations - the round's own dispatch
   *  never inspects `walkXBullAuth`'s tree shape beyond what `assertXBullConversionShape` (unit-
   *  tested directly in `xbull-conversion-round.test.ts`) already covers, so an empty tree that
   *  moves nothing is sufficient to prove the round wires xBull's build through correctly. */
  function xbullAuthEntry(router: string): string {
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(router).toScAddress(),
            functionName: XBULL_SWAP_FUNCTION,
            args: [],
          })
        ),
        subInvocations: [],
      }),
    }).toXDR("base64");
  }

  test("a token pinned to the xbull provider is built and validated through the xbull path, never soroswap's", async () => {
    // The fixture's own contractArgsXDR bakes in a fixed amount (478,000,000) and min_to_get
    // (9,129,329,763), captured from a real, already-executed mainnet transaction (Task 1) - so
    // the live balance this round re-reads, and the pinned/fresh floors it computes, are chosen
    // to be consistent with those baked figures rather than the file's other TOKEN/BALANCE/FLOOR
    // constants (which this test does not use for the balance or floor math).
    const liveBalance = BigInt(xbullFixture.amount);
    const freshAmountOut = "9175000000"; // floor 9,129,125,000: under the baked min_to_get, above the pinned floor
    const pinnedFloor = "9000000000";
    const round = await run(
      account(xbullFixture.amount, { address: xbullFixture.decoded.from }),
      { [TOKEN]: { minAmountOut: pinnedFloor, provider: "xbull" } },
      {
        balance: liveBalance,
        quotedOut: null,
        forbidSoroswap: true,
        xbullFetch: xbullFetchStub(freshAmountOut, xbullFixture.contractArgsXDR),
        xbullAuth: [xbullAuthEntry(XBULL_ROUTER)],
        xbullResolvePath: async () => [TOKEN, XLM],
      }
    );
    expect(round).not.toBeNull();
    expect(round!.transaction.covers).toEqual(["HANDLE_ASSETS"]);
    expect(round!.transaction.sourceSequence).toBe(SEQUENCE);
    expect(round!.transaction.intent.summary).toContain("through xBull");
    expect(round!.transaction.intent.summary).not.toContain("Soroswap");
  });

  test("quote_drifted still fires when the pinned provider's fresh floor falls under the accepted one", async () => {
    const promise = run(
      account(BALANCE.toString()),
      { [TOKEN]: { minAmountOut: "9200000000", provider: "xbull" } },
      {
        balance: BALANCE,
        quotedOut: null,
        forbidSoroswap: true,
        // toAmount 9,000,000,000 -> floor 8,955,000,000, under the 9,200,000,000 pinned above.
        xbullFetch: xbullFetchStub("9000000000", null),
      }
    );
    await expect(promise).rejects.toMatchObject({ code: "quote_drifted" });
  });
});
