/**
 * Soroban token decisions: every held token is asked about, leaving is explicit and only for a
 * token, and the contracts an answer names come back for the close rounds to re-read.
 */
import { expect, mock, spyOn, test } from "bun:test";
import { Address, Keypair } from "@stellar/stellar-sdk";
import type { AccountState, SorobanTokenBalance } from "@lumenwipe/types";
import {
  DESTINATION_ACK_CHOICE,
  LEAVE_CHOICE,
  TOKEN_DISCOVERED_CHOICE,
  destinationDecisionId,
  TRANSFER_CHOICE,
  deriveTokenDecisionPoints,
  resolveDispositions,
  tokenAssetsById,
  tokenContractsFromAnswers,
  tokenDecisionId,
  tokenConversionFloors,
  MissingConversionFloorError,
  UnrecognizedConversionProviderError,
  CONVERSION_IMPACT_ACK_CHOICE,
  CONVERSION_IMPACT_BLOCKER_CODE,
  conversionImpactBlockers,
  conversionImpactDecisionId,
  deriveConversionImpactDecisionPoints,
  isConversionImpactAcknowledged,
  type TokenQuoteSummary,
} from "@/lib/close-api/decisions";
import type { FanoutClock, FanoutProviders } from "@/lib/close-api/token-quote-fanout";
import { parseDecisions } from "@/lib/close-api/parse-decisions";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import * as readAccount from "@/lib/close-api/read-account";
import * as rpcModule from "@/lib/stellar/rpc";
import * as accountStateModule from "@/lib/stellar/account-state";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { servedRegistry } from "@/lib/exchange-registry";
import { ALL_ON } from "@/config/kill-switches";

const TOKEN_A = Address.contract(Buffer.alloc(32, 1)).toString();
const TOKEN_B = Address.contract(Buffer.alloc(32, 2)).toString();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const QUOTE: TokenQuoteSummary = {
  amountOut: "5249630",
  minAmountOut: "5223381",
  platform: "aggregator",
  provider: "soroswap",
  route: ["soroswap"],
  priceImpactBps: 12,
  flags: [],
};
const XBULL_QUOTE: TokenQuoteSummary = {
  amountOut: "5100000",
  minAmountOut: "5074650",
  platform: "router",
  provider: "xbull",
  route: ["xbull"],
  priceImpactBps: 30,
  flags: [],
};

function held(
  contract: string,
  balance: string,
  over: Partial<SorobanTokenBalance> = {}
): SorobanTokenBalance {
  return { contract, balance, symbol: "TKN", decimals: 7, sources: ["explorer"], ...over };
}

function withTokens(tokens: SorobanTokenBalance[]): Pick<AccountState, "sorobanTokens"> {
  return {
    sorobanTokens: { tokens, unreadable: [], coverage: [], eventsScanned: null, warnings: [] },
  };
}

test("every token with a balance gets a required decision: transfer and leave always, convert only with a route and readable metadata", () => {
  const points = deriveTokenDecisionPoints(
    withTokens([held(TOKEN_A, "100"), held(TOKEN_B, "7", { symbol: null, decimals: null })]),
    { [TOKEN_A]: QUOTE, [TOKEN_B]: QUOTE }
  );
  expect(points.map((p) => p.id)).toEqual([tokenDecisionId(TOKEN_A), tokenDecisionId(TOKEN_B)]);
  const [a, b] = points;
  expect(a!.required).toBe(true);
  expect(a!.options.map((o) => o.id)).toEqual(["convert_to_xlm", TRANSFER_CHOICE, LEAVE_CHOICE]);
  expect(a!.default).toBe("convert_to_xlm");
  expect(a!.subject).toMatchObject({
    kind: "soroban_token",
    contract: TOKEN_A,
    convertible: true,
    quote: QUOTE,
  });
  // No symbol or decimals: a swap amount nobody can read is not a decision anyone can make.
  expect(b!.options.map((o) => o.id)).toEqual([TRANSFER_CHOICE, LEAVE_CHOICE]);
  expect(b!.default).toBe(TRANSFER_CHOICE);
  expect(b!.subject).toMatchObject({ convertible: false, symbol: null, decimals: null });
});

test("a quote from either provider produces the same convert_to_xlm option; the subject carries which one won", () => {
  const points = deriveTokenDecisionPoints(withTokens([held(TOKEN_A, "100")]), {
    [TOKEN_A]: XBULL_QUOTE,
  });
  expect(points[0]!.options.map((o) => o.id)).toEqual([
    "convert_to_xlm",
    TRANSFER_CHOICE,
    LEAVE_CHOICE,
  ]);
  expect(points[0]!.default).toBe("convert_to_xlm");
  expect(points[0]!.subject).toMatchObject({ convertible: true, quote: XBULL_QUOTE });
  expect((points[0]!.subject as { quote: TokenQuoteSummary }).quote.provider).toBe("xbull");
});

test("leaving is never the default, and a token with no balance asks nothing", () => {
  const points = deriveTokenDecisionPoints(
    withTokens([held(TOKEN_A, "0"), held(TOKEN_B, "1")]),
    {}
  );
  expect(points).toHaveLength(1);
  expect(points[0]!.id).toBe(tokenDecisionId(TOKEN_B));
  expect(points[0]!.default).not.toBe(LEAVE_CHOICE);
  expect(deriveTokenDecisionPoints({ sorobanTokens: undefined }, {})).toEqual([]);
});

test("acknowledge_residue resolves to leave for a token only; return_to_issuer never applies to a token", () => {
  const byId = [
    { id: tokenDecisionId(TOKEN_A), asset: TOKEN_A },
    { id: tokenDecisionId(TOKEN_B), asset: TOKEN_B },
    { id: `asset:${USDC.replace(":", "-")}`, asset: USDC },
  ];
  const resolved = resolveDispositions(
    [
      { id: tokenDecisionId(TOKEN_A), choice: LEAVE_CHOICE },
      { id: tokenDecisionId(TOKEN_B), choice: "return_to_issuer" },
      { id: `asset:${USDC.replace(":", "-")}`, choice: LEAVE_CHOICE },
    ],
    byId
  );
  expect(resolved).toEqual({ [TOKEN_A]: "leave" });
});

test("the token contracts an answer set names come back deduplicated and well-formed, nothing else", () => {
  expect(
    tokenContractsFromAnswers([
      { id: tokenDecisionId(TOKEN_A), choice: TRANSFER_CHOICE },
      { id: tokenDecisionId(TOKEN_A), choice: LEAVE_CHOICE },
      { id: tokenDecisionId(TOKEN_B), choice: "convert_to_xlm" },
      { id: "token:not-a-contract", choice: LEAVE_CHOICE },
      { id: `asset:${USDC.replace(":", "-")}`, choice: "convert_to_xlm" },
    ])
  ).toEqual([TOKEN_A, TOKEN_B]);
});

test("tokenAssetsById lists only balances the decision machinery can act on", () => {
  expect(
    tokenAssetsById(withTokens([held(TOKEN_A, "3"), held(TOKEN_B, "0"), held(TOKEN_B, "x")]))
  ).toEqual([{ id: tokenDecisionId(TOKEN_A), asset: TOKEN_A }]);
});

test("a position's payout token the account does not hold yet is asked about ahead of the exit, flagged as arriving", () => {
  const points = deriveTokenDecisionPoints(
    withTokens([
      held(TOKEN_A, "0", { sources: ["positions"] }),
      held(TOKEN_B, "0", { sources: ["list"] }),
    ]),
    {}
  );
  expect(points.map((p) => p.id)).toEqual([tokenDecisionId(TOKEN_A)]);
  expect(points[0]!.subject).toMatchObject({ arrivesFromExit: true, balance: "0" });
  expect(points[0]!.options.map((o) => o.id)).toEqual([TRANSFER_CHOICE, LEAVE_CHOICE]);
});

test("a balance that is not a decimal string is ignored rather than thrown on", () => {
  expect(deriveTokenDecisionPoints(withTokens([held(TOKEN_A, "1e5")]), {})).toEqual([]);
});

test("tokenContractsFromAnswers stops at the discovery cap", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: tokenDecisionId(Address.contract(Buffer.alloc(32, 100 + i)).toString()),
    choice: LEAVE_CHOICE,
  }));
  expect(tokenContractsFromAnswers(many)).toHaveLength(50);
});

test("a token without a usable quote is offered no conversion, and a null quote reads like none", () => {
  const points = deriveTokenDecisionPoints(withTokens([held(TOKEN_A, "100")]), { [TOKEN_A]: null });
  expect(points[0]!.options.map((o) => o.id)).toEqual([TRANSFER_CHOICE, LEAVE_CHOICE]);
  expect(points[0]!.subject).not.toHaveProperty("quote");
});

test("a token's convert answer must carry the floor it was quoted; a classic asset's never does", () => {
  const byId = [
    { id: tokenDecisionId(TOKEN_A), asset: TOKEN_A },
    { id: `asset:${USDC.replace(":", "-")}`, asset: USDC },
  ];
  expect(
    tokenConversionFloors(
      [
        {
          id: tokenDecisionId(TOKEN_A),
          choice: "convert_to_xlm",
          params: { minAmountOut: "5223381" },
        },
        { id: `asset:${USDC.replace(":", "-")}`, choice: "convert_to_xlm" },
      ],
      byId
    )
  ).toEqual({ [TOKEN_A]: { minAmountOut: "5223381", provider: "soroswap" } });
  for (const params of [undefined, {}, { minAmountOut: "0" }, { minAmountOut: "12.5" }]) {
    expect(() =>
      tokenConversionFloors(
        [{ id: tokenDecisionId(TOKEN_A), choice: "convert_to_xlm", params }],
        byId
      )
    ).toThrow(MissingConversionFloorError);
  }
  // A later answer that moved the token off convert leaves no floor to demand.
  expect(
    tokenConversionFloors(
      [
        { id: tokenDecisionId(TOKEN_A), choice: "convert_to_xlm" },
        { id: tokenDecisionId(TOKEN_A), choice: LEAVE_CHOICE },
      ],
      byId
    )
  ).toEqual({});
});

test("tokenConversionFloors carries the pinned provider alongside the floor", () => {
  const byId = [{ id: tokenDecisionId(TOKEN_A), asset: TOKEN_A }];
  const floors = tokenConversionFloors(
    [
      {
        id: tokenDecisionId(TOKEN_A),
        choice: "convert_to_xlm",
        params: { minAmountOut: "100", provider: "xbull" },
      },
    ],
    byId
  );
  expect(floors[TOKEN_A]).toEqual({ minAmountOut: "100", provider: "xbull" });
});

test("a missing provider defaults to soroswap, the only provider that existed before this feature", () => {
  const byId = [{ id: tokenDecisionId(TOKEN_A), asset: TOKEN_A }];
  const floors = tokenConversionFloors(
    [{ id: tokenDecisionId(TOKEN_A), choice: "convert_to_xlm", params: { minAmountOut: "100" } }],
    byId
  );
  expect(floors[TOKEN_A]).toEqual({ minAmountOut: "100", provider: "soroswap" });
});

test("a present but unrecognized provider is refused rather than silently built through soroswap", () => {
  const byId = [{ id: tokenDecisionId(TOKEN_A), asset: TOKEN_A }];
  expect(() =>
    tokenConversionFloors(
      [
        {
          id: tokenDecisionId(TOKEN_A),
          choice: "convert_to_xlm",
          // A client bug (typo of "xbull") or any other string outside the recognized set: the
          // DTO's own TS type only names the two real providers, but nothing at runtime stops an
          // unvalidated request body from carrying anything else, so the check must be a real
          // runtime one, not just a type annotation.
          params: { minAmountOut: "100", provider: "xbulll" as never },
        },
      ],
      byId
    )
  ).toThrow(UnrecognizedConversionProviderError);
});

test("a discovered-token answer passes request validation, names its contract and decides nothing", () => {
  const answers = parseDecisions([{ id: tokenDecisionId(TOKEN_A), choice: "discovered" }]);
  expect(TOKEN_DISCOVERED_CHOICE).toBe("discovered");
  expect(tokenContractsFromAnswers(answers)).toEqual([TOKEN_A]);
  expect(resolveDispositions(answers, [{ id: tokenDecisionId(TOKEN_A), asset: TOKEN_A }])).toEqual(
    {}
  );
});

test("the plan still asks about a held token whose only answer is the discovery hint", async () => {
  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  spyOn(readAccount, "readAccountState").mockResolvedValue({
    address: source,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "50.0000000",
    dataEntries: [],
    signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
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
    defiPositions: emptyDefiPositionsResult(source),
    defiPositionsWarnings: [],
    ...withTokens([held(TOKEN_A, "3")]),
  });
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getLatestLedger: () => Promise.resolve({ sequence: 1_000_000 }),
  })) as unknown as typeof rpcModule.getRpcServer);
  spyOn(accountStateModule, "readTrustlinesOnly").mockResolvedValue({
    address: destination,
    trustlines: [],
    memoRequired: false,
  });
  stubIssuance();
  try {
    const plan = await buildAccountPlan(
      source,
      destination,
      [
        { id: destinationDecisionId(destination), choice: DESTINATION_ACK_CHOICE },
        { id: tokenDecisionId(TOKEN_A), choice: TOKEN_DISCOVERED_CHOICE },
      ],
      "testnet",
      ALL_ON
    );
    expect(plan.status).toBe("needs_decisions");
    const answered = await buildAccountPlan(
      source,
      destination,
      [
        { id: destinationDecisionId(destination), choice: DESTINATION_ACK_CHOICE },
        { id: tokenDecisionId(TOKEN_A), choice: TOKEN_DISCOVERED_CHOICE },
        { id: tokenDecisionId(TOKEN_A), choice: LEAVE_CHOICE },
      ],
      "testnet",
      ALL_ON
    );
    expect(answered.status).toBe("ready");
  } finally {
    mock.restore();
  }
});

test("the plan blocks a token sent to a listed exchange or to an account that requires a memo", async () => {
  const source = Keypair.random().publicKey();
  const wallet = Keypair.random().publicKey();
  const exchange = servedRegistry().entries[0]!;
  spyOn(readAccount, "readAccountState").mockResolvedValue({
    address: source,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "50.0000000",
    dataEntries: [],
    signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
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
    defiPositions: emptyDefiPositionsResult(source),
    defiPositionsWarnings: [],
    ...withTokens([held(TOKEN_A, "3"), held(TOKEN_B, "4")]),
  });
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getLatestLedger: () => Promise.resolve({ sequence: 1_000_000 }),
  })) as unknown as typeof rpcModule.getRpcServer);
  spyOn(accountStateModule, "readTrustlinesOnly").mockImplementation(async (address) => ({
    address,
    trustlines: [],
    memoRequired: address === wallet,
  }));
  stubIssuance();
  try {
    const plan = await buildAccountPlan(
      source,
      wallet,
      [
        { id: destinationDecisionId(wallet), choice: DESTINATION_ACK_CHOICE },
        {
          id: tokenDecisionId(TOKEN_A),
          choice: TRANSFER_CHOICE,
          params: { destination: exchange.address },
        },
        { id: tokenDecisionId(TOKEN_B), choice: TRANSFER_CHOICE, params: { destination: wallet } },
      ],
      "testnet",
      ALL_ON
    );
    expect(plan.status).toBe("blocked");
    const messages = plan.blockers.map((b) => b.message);
    expect(messages).toContainEqual(
      expect.stringContaining(`deposit address for ${exchange.name}`)
    );
    expect(messages).toContainEqual(expect.stringContaining("needs a memo"));
  } finally {
    mock.restore();
  }
});

const FLAGGED: TokenQuoteSummary = { ...QUOTE, priceImpactBps: 2_400, flags: ["high_impact"] };

test("a flagged quote is offered but never recommended, and is not the default", () => {
  for (const flags of [
    ["high_impact"],
    ["impact_unknown"],
    ["provider_disagreement"],
  ] as TokenQuoteSummary["flags"][]) {
    const [point] = deriveTokenDecisionPoints(withTokens([held(TOKEN_A, "100")]), {
      [TOKEN_A]: { ...QUOTE, flags },
    });
    const convert = point!.options.find((o) => o.id === "convert_to_xlm");
    expect(convert).toBeDefined();
    expect(convert!.recommended).toBeUndefined();
    expect(convert!.note).toContain("needs your confirmation");
    expect(point!.default).toBe(TRANSFER_CHOICE);
    expect(point!.subject).toMatchObject({ convertible: true, quote: { flags } });
  }
  // Unflagged: unchanged, recommended and the default.
  const [plain] = deriveTokenDecisionPoints(withTokens([held(TOKEN_A, "100")]), {
    [TOKEN_A]: QUOTE,
  });
  expect(plain!.options[0]).toEqual({ id: "convert_to_xlm", recommended: true });
  expect(plain!.default).toBe("convert_to_xlm");
});

test("the high-impact copy says the swap delivers much less than the market price suggests", () => {
  const [point] = deriveTokenDecisionPoints(withTokens([held(TOKEN_A, "100")]), {
    [TOKEN_A]: FLAGGED,
  });
  const note = point!.options[0]!.note!;
  expect(note).toContain("much less than the current market price suggests");
  expect(note).not.toMatch(/thin|worth/i);
});

test("a token beyond the quote limit, one with a provider error and one with no route each carry their own reason", () => {
  const TOKEN_C = Address.contract(Buffer.alloc(32, 3)).toString();
  const TOKEN_D = Address.contract(Buffer.alloc(32, 4)).toString();
  const points = deriveTokenDecisionPoints(
    withTokens([
      held(TOKEN_A, "1"),
      held(TOKEN_B, "1"),
      held(TOKEN_C, "1"),
      held(TOKEN_D, "1", { symbol: null }),
    ]),
    {},
    { [TOKEN_A]: "quote_limit", [TOKEN_B]: "provider_unavailable", [TOKEN_C]: "no_route" }
  );
  expect(points.map((p) => p.subject.reason)).toEqual([
    "quote_limit",
    "provider_unavailable",
    "no_route",
    "metadata_unreadable",
  ]);
  // A convertible token carries no reason.
  const [convertible] = deriveTokenDecisionPoints(withTokens([held(TOKEN_A, "1")]), {
    [TOKEN_A]: QUOTE,
  });
  expect(convertible!.subject).not.toHaveProperty("reason");
});

test("only a flagged token gets a conversion-impact confirmation, and it is not required on its own", () => {
  const points = deriveConversionImpactDecisionPoints(
    withTokens([held(TOKEN_A, "100"), held(TOKEN_B, "100")]),
    { [TOKEN_A]: FLAGGED, [TOKEN_B]: QUOTE }
  );
  expect(points).toHaveLength(1);
  expect(points[0]).toMatchObject({
    id: conversionImpactDecisionId(TOKEN_A),
    type: "confirmation",
    subject: { kind: "conversion_impact", contract: TOKEN_A, minAmountOut: QUOTE.minAmountOut },
    options: [{ id: CONVERSION_IMPACT_ACK_CHOICE }],
    default: "",
    required: false,
  });
});

test("a confirmation counts only for the exact floor the latest convert answer carries", () => {
  const convert = (floor: string) => ({
    id: tokenDecisionId(TOKEN_A),
    choice: "convert_to_xlm",
    params: { minAmountOut: floor, provider: "soroswap" as const },
  });
  const ack = (floor?: string) => ({
    id: conversionImpactDecisionId(TOKEN_A),
    choice: CONVERSION_IMPACT_ACK_CHOICE,
    ...(floor ? { params: { minAmountOut: floor } } : {}),
  });
  // The confirmation passes request validation as it is sent.
  expect(parseDecisions([convert("500"), ack("500")])).toEqual([convert("500"), ack("500")]);
  expect(isConversionImpactAcknowledged([convert("500"), ack("500")], TOKEN_A)).toBe(true);
  expect(isConversionImpactAcknowledged([convert("500"), ack("499")], TOKEN_A)).toBe(false);
  expect(isConversionImpactAcknowledged([convert("500"), ack()], TOKEN_A)).toBe(false);
  expect(isConversionImpactAcknowledged([ack("500")], TOKEN_A)).toBe(false);
  // A later convert answer with a new floor is not covered by the earlier confirmation.
  expect(
    isConversionImpactAcknowledged([convert("500"), ack("500"), convert("450")], TOKEN_A)
  ).toBe(false);
  expect(
    isConversionImpactAcknowledged(
      [convert("500"), { ...ack("500"), choice: "something_else" }],
      TOKEN_A
    )
  ).toBe(false);
});

test("a flagged token answered convert without a confirmation raises the blocker; transfer or a confirmation clears it", () => {
  const account = withTokens([held(TOKEN_A, "100")]);
  const quotes = { [TOKEN_A]: FLAGGED };
  const convert = {
    id: tokenDecisionId(TOKEN_A),
    choice: "convert_to_xlm",
    params: { minAmountOut: FLAGGED.minAmountOut },
  };
  const blockers = conversionImpactBlockers(account, quotes, { [TOKEN_A]: "convert" }, [convert]);
  expect(blockers).toHaveLength(1);
  expect(blockers[0]!.code).toBe(CONVERSION_IMPACT_BLOCKER_CODE);
  expect(blockers[0]!.message).toContain("TKN");
  expect(conversionImpactBlockers(account, quotes, { [TOKEN_A]: "transfer" }, [])).toEqual([]);
  expect(
    conversionImpactBlockers(account, quotes, { [TOKEN_A]: "convert" }, [
      convert,
      {
        id: conversionImpactDecisionId(TOKEN_A),
        choice: CONVERSION_IMPACT_ACK_CHOICE,
        params: { minAmountOut: FLAGGED.minAmountOut },
      },
    ])
  ).toEqual([]);
});

/** A clock that never waits: the providers below answer at once. */
const instantClock: FanoutClock = {
  now: () => 0,
  sleep: async () => {},
  timeout: (work) => work,
  random: () => 0,
};

test("the plan gates a flagged conversion on its confirmation, and marks a token past the quote limit", async () => {
  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  const many = Array.from({ length: 21 }, (_, i) =>
    held(Address.contract(Buffer.alloc(32, 10 + i)).toString(), "100")
  );
  const flaggedToken = many[0]!.contract;
  spyOn(readAccount, "readAccountState").mockResolvedValue({
    address: source,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "50.0000000",
    dataEntries: [],
    signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
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
    defiPositions: emptyDefiPositionsResult(source),
    defiPositionsWarnings: [],
    ...withTokens(many),
  });
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getLatestLedger: () => Promise.resolve({ sequence: 1_000_000 }),
  })) as unknown as typeof rpcModule.getRpcServer);
  spyOn(accountStateModule, "readTrustlinesOnly").mockResolvedValue({
    address: destination,
    trustlines: [],
    memoRequired: false,
  });
  stubIssuance();
  const tokenQuoteProviders: FanoutProviders = {
    quote: {
      soroswap: async (token, amountIn) =>
        token === flaggedToken
          ? {
              kind: "quote",
              quote: {
                token,
                amountIn: amountIn.toString(),
                amountOut: "5000",
                minAmountOut: "4975",
                platform: "aggregator",
                route: ["soroswap"],
                raw: { priceImpactPct: "31.5" } as never,
              },
            }
          : { kind: "unavailable" },
      xbull: async () => ({ kind: "disabled" }),
    },
    resolveXBullRoute: async () => undefined,
  };
  const everyOtherLeft = many
    .slice(1)
    .map((t) => ({ id: tokenDecisionId(t.contract), choice: LEAVE_CHOICE }));
  const base = [
    { id: destinationDecisionId(destination), choice: DESTINATION_ACK_CHOICE },
    ...everyOtherLeft,
    {
      id: tokenDecisionId(flaggedToken),
      choice: "convert_to_xlm",
      params: { minAmountOut: "4975" },
    },
  ];
  const plan = (decisions: typeof base) =>
    buildAccountPlan(source, destination, decisions, "testnet", ALL_ON, {
      tokenQuoteProviders,
      tokenQuoteClock: instantClock,
    });
  try {
    const unconfirmed = await plan(base);
    const reasons = unconfirmed.decisionPoints
      .filter((d) => d.type === "asset_disposition")
      .map((d) => d.subject.reason);
    expect(reasons.filter((r) => r === "provider_unavailable")).toHaveLength(19);
    expect(reasons.at(-1)).toBe("quote_limit");
    expect(unconfirmed.blockers.map((b) => b.code)).toContain(CONVERSION_IMPACT_BLOCKER_CODE);
    expect(unconfirmed.status).toBe("blocked");

    const stale = await plan([
      ...base,
      {
        id: conversionImpactDecisionId(flaggedToken),
        choice: CONVERSION_IMPACT_ACK_CHOICE,
        params: { minAmountOut: "4000" },
      },
    ]);
    expect(stale.blockers.map((b) => b.code)).toContain(CONVERSION_IMPACT_BLOCKER_CODE);

    const confirmed = await plan([
      ...base,
      {
        id: conversionImpactDecisionId(flaggedToken),
        choice: CONVERSION_IMPACT_ACK_CHOICE,
        params: { minAmountOut: "4975" },
      },
    ]);
    expect(confirmed.blockers.map((b) => b.code)).not.toContain(CONVERSION_IMPACT_BLOCKER_CODE);
    expect(confirmed.status).toBe("ready");
  } finally {
    mock.restore();
  }
});
