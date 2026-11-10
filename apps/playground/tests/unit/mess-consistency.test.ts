import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  scValToNative,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { executeMessStep } from "@/lib/mess-builders";
import { contractCallOp } from "@/lib/soroban-seed";
import { networkStroops } from "@/lib/stroops";
import {
  maxOfferCount,
  selectionForMode,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
} from "@/lib/mess-plan";
import { handleCreateSession, handleMess } from "@/lib/route-handlers";
import {
  ALLOWANCE_SEED,
  AQUARIUS,
  AQUARIUS_SEED,
  BLEND,
  BLEND_REQUEST,
  BLEND_SEED,
  closesToExchange,
  EXCHANGE_STAND_IN,
  JUNK_OFFERS,
  PHOENIX,
  PHOENIX_SEED,
  PINNED_ASSETS,
  SCENARIOS,
  SOROSWAP,
  SOROSWAP_SEED,
  XLM_SAC,
  helperRoleOf,
  resolvePlan,
  validateSelection,
  type MessStepId,
  type ScenarioSelection,
} from "@/lib/scenarios";
import type { RecordedAllowance } from "@/lib/session-store";
import { expectationFromSession, maxOperations } from "@/lib/verify";
import { memoryStore } from "./session-fixtures";

// The plan a visitor sees (and the scene animates), what the executor posts on chain, and what the
// verifier will let the close remove must all agree. Each case goes through the real create and
// mess handlers and the real executor, with only the network replaced: the signed transactions are
// captured and decoded instead of sent. Keys are generated per run; the "encryption" is a
// reversible stand-in.

const ORIGIN = "http://localhost:3002";
/** What the Phoenix steps read, fixed instead of simulated: a quote inside the gate, the pool's
 *  reserves, and the LWPHX and shares the demo then holds. */
const PHOENIX_QUOTE = { askAmount: BigInt(4_700_000), spreadAmount: BigInt(33_000) };
const PHOENIX_RESERVES = { reserveA: BigInt(675_000_000), reserveB: BigInt(710_000_000) };
const PHOENIX_LWPHX = BigInt(4_700_000);
const PHOENIX_SHARES = BigInt(4_812_345);
/** The ledger and entry TTL the allowance steps read, fixed instead of read from the RPC. */
const LEDGER_TTL = { latestLedger: 1_000, maxEntryTtl: 3_110_400 };
const encrypt = (plaintext: string): string => Buffer.from(plaintext, "utf8").toString("base64");
const decrypt = (payload: string): string => Buffer.from(payload, "base64").toString("utf8");

interface Posted {
  stepId: MessStepId;
  tx: Transaction;
}

const issuer = Keypair.random();
const mm = Keypair.random();
const CRON_SECRET = randomBytes(16).toString("hex");

function setupFunding(plan: ReturnType<typeof resolvePlan>): string {
  const setup = plan.steps.find((s) => s.action.kind === "setup")?.action;
  if (setup?.kind !== "setup") throw new Error("a plan with no setup step");
  return setup.fundingXlm;
}

async function runAndCheck(selection: ScenarioSelection): Promise<void> {
  const store = memoryStore();
  const ensured: string[] = [];
  const created = await handleCreateSession(
    new NextRequest(new URL("/api/session", ORIGIN), {
      method: "POST",
      body: JSON.stringify({ selection }),
    }),
    {
      store,
      rateLimit: async () => null,
      issuer: () => issuer,
      mm: () => mm,
      cronSecret: () => CRON_SECRET,
      marketMakerBalance: async () => ({ balance: "10000.0000000", sellingLiabilities: "0" }),
      ensureExchangeAccount: async (_mm, address) => ensured.push(address),
      provisionDemo: async () => {},
      encrypt,
      unavailable: () => new Map(),
    }
  );
  expect(created.status).toBe(200);
  const { sessionId, demoPublic } = (await created.json()) as {
    sessionId: string;
    demoPublic: string;
  };
  const plan = resolvePlan(selection);

  const posted: Posted[] = [];
  for (const step of plan.steps) {
    const res = await handleMess(
      new NextRequest(new URL(`/api/session/${sessionId}/mess`, ORIGIN), {
        method: "POST",
        body: JSON.stringify({ stepId: step.id }),
      }),
      sessionId,
      {
        store,
        issuer: () => issuer,
        mm: () => mm,
        encrypt,
        decrypt,
        executeMessStep: (planned, ctx) =>
          executeMessStep(planned, ctx, {
            loadAccount: async () => ({ sequenceNumber: () => "100" }),
            loadNativeBalance: async () => ({
              balance: setupFunding(plan),
              sellingLiabilities: "0",
            }),
            submit: async (signedXdr) => {
              const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
              if (!(tx instanceof Transaction)) throw new Error("expected a transaction");
              posted.push({ stepId: planned.id, tx });
              return { txHash: Buffer.from(tx.hash()).toString("hex") };
            },
            sleep: async () => {},
            quoteBuy: async () => ({ sourceAmount: "2.6", path: [] }),
            // A Blend pool with room to lend: half its XLM borrowed.
            blendReserve: async () => ({
              maxUtil: BigInt(9_500_000),
              bSupply: BigInt(2) * BigInt(10) ** BigInt(15),
              dSupply: BigInt(10) ** BigInt(15),
              bRate: BigInt(10) ** BigInt(12),
              dRate: BigInt(10) ** BigInt(12),
            }),
            ledgerTtl: async () => LEDGER_TTL,
            phoenix: {
              swapQuote: async () => PHOENIX_QUOTE,
              reserves: async () => PHOENIX_RESERVES,
              balance: async (token) => (token === PHOENIX.tokenA ? PHOENIX_LWPHX : PHOENIX_SHARES),
            },
            // What the drain reads: the funding, with the plan's entries holding their reserves.
            reserveState: async () => ({
              balanceStroops: networkStroops(setupFunding(plan)),
              sellingLiabilitiesStroops: BigInt(0),
              subentryCount: plan.cost.subEntries,
              numSponsoring: 0,
              numSponsored: 0,
              baseReserveStroops: BigInt(5_000_000),
              baseFeeStroops: BigInt(100),
            }),
            // The contract call as the seeding would send it, captured instead.
            contractCall: async (source, call) => {
              const tx = new TransactionBuilder(new Account(source.publicKey(), "100"), {
                fee: "100",
                networkPassphrase: Networks.TESTNET,
              })
                .addOperation(contractCallOp(call))
                .setTimeout(60)
                .build();
              posted.push({ stepId: planned.id, tx });
              return { txHash: Buffer.from(tx.hash()).toString("hex") };
            },
          }),
      }
    );
    expect(res.status).toBe(200);
    // Funded exactly, a setup with no issuers to create has nothing to send: it completes with no
    // transaction. Every other step answers with the hash of the one it sent.
    const { txHash } = (await res.json()) as { txHash: string | null };
    const sendsNothing = step.action.kind === "setup" && plan.ephemeralAssets.length === 0;
    expect(txHash === null).toBe(sendsNothing);
  }

  const session = (await store.loadSession(sessionId))!;
  const expected = expectationFromSession(session, mm.publicKey(), issuer.publicKey(), null);
  // An exchange session records the bundled stand-in and an id memo, and the market maker makes
  // sure the stand-in exists before the demo is funded; any other session records neither.
  if (closesToExchange(selection)) {
    expect(session.exchange).toEqual({
      destination: EXCHANGE_STAND_IN.address,
      memo: expect.stringMatching(/^[1-9][0-9]*$/),
      memoType: "id",
    });
    expect(ensured).toEqual([EXCHANGE_STAND_IN.address]);
    expect(expected.exchange?.destination).toBe(EXCHANGE_STAND_IN.address);
  } else {
    expect(session.exchange).toBeNull();
    expect(ensured).toEqual([]);
    expect(expected.exchange).toBeNull();
  }
  assertConsistent({
    plan,
    demoPublic,
    posted,
    expected,
    issuers: session.ephemeralIssuers,
    recipient: session.transferRecipient?.publicKey ?? null,
    helpers: session.helperAccounts.map((h) => h.publicKey),
    allowances: session.allowances,
  });

  // Every balance the mess created is recorded under the id its own signed transaction gives it.
  const balanceIds = posted.flatMap(({ tx }) =>
    tx.operations.flatMap((op, i) =>
      op.type === "createClaimableBalance" ? [tx.getClaimableBalanceId(i)] : []
    )
  );
  expect(session.claimableBalances.map((b) => b.id)).toEqual(balanceIds);
  const planned = plan.steps.flatMap((s) =>
    s.action.kind === "claimable_balances" ? s.action.balances.map((b) => b.intent) : []
  );
  expect(session.claimableBalances.map((b) => b.intent)).toEqual(planned);
  // Each helper the plan needs exists, once.
  expect(session.helperAccounts.map((h) => h.role)).toEqual(
    plan.steps.flatMap((s) => {
      const role = helperRoleOf(s.action);
      return role ? [role] : [];
    })
  );
}

const CIRCLE_USDC = PINNED_ASSETS["circle-usdc"];

/** An asset as the scene names its trustline: a pinned asset by its id, any other by its code. */
const label = (asset: Asset): string => {
  if (asset.isNative()) return "native";
  return asset.getCode() === CIRCLE_USDC.code && asset.getIssuer() === CIRCLE_USDC.issuer
    ? "circle-usdc"
    : asset.getCode();
};

function assertConsistent({
  plan,
  demoPublic,
  posted,
  expected,
  issuers,
  recipient,
  helpers,
  allowances,
}: {
  plan: ReturnType<typeof resolvePlan>;
  demoPublic: string;
  posted: Posted[];
  expected: ReturnType<typeof expectationFromSession>;
  issuers: { assetCode: string; publicKey: string }[];
  recipient: string | null;
  helpers: string[];
  allowances: RecordedAllowance[];
}): void {
  // Every plan step posted exactly one transaction, in plan order, except a setup with no issuers
  // to create; and no transaction is empty, which the network rejects (tx_missing_operation).
  const sending = plan.steps.filter(
    (s) => s.action.kind !== "setup" || s.action.ephemeralAssets.length > 0
  );
  expect(posted.map((p) => p.stepId)).toEqual(sending.map((s) => s.id));
  for (const { tx } of posted) expect(tx.operations.length).toBeGreaterThan(0);
  const nodes = (kind: string): string[] =>
    plan.steps.flatMap((s) => s.nodes.filter((n) => n.kind === kind).map((n) => n.id));

  const trusted = new Set<string>(["native"]);
  const trustlines: string[] = [];
  const createdIssuers: string[] = [];
  const dataNames: string[] = [];
  const offerNodes: string[] = [];
  const airdrops: string[] = [];
  const recipientTrusts: string[] = [];
  let recipientsCreated = 0;
  let helperEntries = 0;
  let signersAdded = 0;
  const positions: string[] = [];
  const approved: string[] = [];

  for (const { stepId, tx } of posted) {
    for (const op of tx.operations) {
      const source = op.source ?? tx.source;
      // A helper's own entries are not the demo's; the expectation covers them separately.
      if (helpers.includes(source)) {
        if (op.type === "changeTrust" || op.type === "manageData") helperEntries++;
        continue;
      }
      switch (op.type) {
        case "createAccount":
          if (helpers.includes(op.destination)) break;
          if (op.destination === recipient) recipientsCreated++;
          else createdIssuers.push(op.destination);
          break;
        case "changeTrust":
          if (recipient !== null && source === recipient) {
            if (op.line instanceof Asset) recipientTrusts.push(label(op.line));
            break;
          }
          expect(source).toBe(demoPublic);
          if (op.line instanceof Asset) {
            trusted.add(label(op.line));
            trustlines.push(label(op.line));
          }
          break;
        case "manageData":
          expect(source).toBe(demoPublic);
          dataNames.push(`data:${op.name}`);
          break;
        case "manageSellOffer": {
          if (source !== demoPublic) break; // a swap counterparty's offer, not one the demo keeps
          for (const asset of [op.selling, op.buying]) expect(trusted.has(label(asset))).toBe(true);
          const index = JUNK_OFFERS.findIndex(
            (o) => o.selling === label(op.selling) && o.buying === label(op.buying)
          );
          offerNodes.push(index >= 0 ? `offer:${index}` : "offer:sponsored");
          break;
        }
        case "payment":
          if (op.destination !== demoPublic) break;
          expect(trusted.has(label(op.asset))).toBe(true);
          if (stepId === "FUND_RARE") airdrops.push(`tl:${label(op.asset)}`);
          break;
        case "pathPaymentStrictReceive":
          if (op.destination === demoPublic) expect(trusted.has(label(op.destAsset))).toBe(true);
          break;
        case "setOptions":
          expect(source).toBe(demoPublic);
          if (op.signer) signersAdded++;
          break;
        case "invokeHostFunction": {
          // A seeding call: the demo pairs the USDC it bought with XLM in a pinned pool, through
          // that protocol's pinned router, and the share is the demo's own.
          expect(source).toBe(demoPublic);
          if (op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a call");
          const call = op.func.invokeContract;
          const args = call.args.map((a) => scValToNative(a) as unknown);
          const contract = Address.fromScAddress(call.contractAddress).toString();
          const stroops = (amount: string): bigint => BigInt(Number(amount) * 10_000_000);
          if (contract === BLEND.pool) {
            // XLM supplied as collateral, and borrowed against it when the plan says so; the
            // demo on every side, and nothing bought for it.
            const action = plan.steps.find((s) => s.id === stepId)?.action;
            if (action?.kind !== "blend_submit") throw new Error("not the Blend step");
            expect(call.functionName.toString()).toBe("submit");
            const request = (type: number, xlm: string) => ({
              address: BLEND.reserve,
              amount: stroops(xlm),
              request_type: type,
            });
            expect(args).toEqual([
              demoPublic,
              demoPublic,
              demoPublic,
              [
                request(BLEND_REQUEST.supplyCollateral, BLEND_SEED.supplyXlm),
                ...(action.variant === "supply_and_borrow"
                  ? [request(BLEND_REQUEST.borrow, BLEND_SEED.borrowXlm)]
                  : []),
              ],
            ]);
            positions.push("lend:blend");
            break;
          }
          if (contract === PHOENIX.pool || contract === PHOENIX.stake) {
            // LWPHX bought from the pool itself, all of it paired back with XLM, and half the
            // shares bonded when the plan bonds; nothing bought on the DEX for it.
            const fn = call.functionName.toString();
            if (stepId === "PHOENIX_SWAP") {
              expect([contract, fn]).toEqual([PHOENIX.pool, "swap"]);
              expect(args.slice(0, 3)).toEqual([
                demoPublic,
                PHOENIX.tokenB,
                stroops(PHOENIX_SEED.swapXlm),
              ]);
            } else if (stepId === "PHOENIX_PROVIDE") {
              expect([contract, fn]).toEqual([PHOENIX.pool, "provide_liquidity"]);
              expect(args.slice(0, 2)).toEqual([demoPublic, PHOENIX_LWPHX]);
              positions.push("lp:phoenix");
            } else {
              expect([stepId, contract, fn]).toEqual(["PHOENIX_BOND", PHOENIX.stake, "bond"]);
              expect(args).toEqual([demoPublic, PHOENIX_SHARES / BigInt(2)]);
            }
            break;
          }
          if (contract === XLM_SAC) {
            // An approval on XLM's asset contract, to the spender the session recorded for it,
            // living until the far expiry for the first spender and a week for the others.
            const action = plan.steps.find((s) => s.id === stepId)?.action;
            if (action?.kind !== "approve_allowance") throw new Error("not an approve step");
            expect(call.functionName.toString()).toBe("approve");
            const recorded = allowances[action.index - 1];
            const liveUntil = action.farExpiry
              ? LEDGER_TTL.latestLedger + LEDGER_TTL.maxEntryTtl - 1
              : LEDGER_TTL.latestLedger + ALLOWANCE_SEED.liveLedgers;
            expect(recorded).toEqual({
              token: XLM_SAC,
              spender: args[1] as string,
              liveUntilLedger: liveUntil,
            });
            expect(args).toEqual([
              demoPublic,
              recorded?.spender,
              stroops(action.amountXlm),
              liveUntil,
            ]);
            approved.push(`allowance:${action.index}`);
            break;
          }
          expect(trusted.has("circle-usdc")).toBe(true);
          if (contract === AQUARIUS.router) {
            expect(call.functionName.toString()).toBe("deposit");
            expect(args).toEqual([
              demoPublic,
              [...AQUARIUS.tokens],
              Buffer.from(AQUARIUS.poolIndex, "hex"),
              [stroops(AQUARIUS_SEED.usdc), stroops(AQUARIUS_SEED.depositMaxXlm)],
              BigInt(1),
            ]);
            positions.push("lp:aquarius");
            break;
          }
          expect(contract).toBe(SOROSWAP.router);
          expect(call.functionName.toString()).toBe("add_liquidity");
          expect(args.slice(0, 2)).toEqual([...SOROSWAP.tokens]);
          expect(args[2]).toBe(stroops(SOROSWAP_SEED.usdc));
          expect(args[3]).toBe(stroops(SOROSWAP_SEED.depositMaxXlm));
          expect(args[6]).toBe(demoPublic);
          positions.push("lp:soroswap");
          break;
        }
      }
    }
  }

  // The plan's scene nodes are what the chain received.
  expect(trustlines.map((code) => `tl:${code}`).sort()).toEqual(nodes("trustline").sort());
  expect(dataNames).toEqual(nodes("data"));
  expect(offerNodes).toEqual(nodes("offer"));
  expect(signersAdded).toBe(nodes("signer").length);
  expect(positions).toEqual(nodes("position"));
  // One recorded allowance per approval, and an allowance node for each.
  expect(approved).toEqual(nodes("allowance"));
  expect(allowances).toHaveLength(approved.length);
  // A seeded protocol is one the verifier admits an exit for, and only then.
  expect(expected.sorobanSeeded.length).toBe(positions.length);
  const fundRare = plan.steps.find((s) => s.id === "FUND_RARE");
  expect(airdrops).toEqual(fundRare ? fundRare.balances.map((b) => b.nodeId) : []);
  expect(createdIssuers).toEqual(issuers.map((i) => i.publicKey));
  expect(issuers.map((i) => i.assetCode)).toEqual(plan.ephemeralAssets);

  // The verifier's expectation counts exactly the entries the chain received.
  // A balance claimed through a new trustline adds an asset the close returns and removes.
  const arriving = plan.expectation.arrivingAssets;
  const codeOf = (l: string): string => (l === "circle-usdc" ? CIRCLE_USDC.code : l);
  expect(expected.assets.map((a) => a.code).sort()).toEqual(
    [...trustlines.map(codeOf), ...arriving].sort()
  );
  // Each entry the demo sponsors on its beneficiary is one the close may revoke.
  expect(expected.sponsoredEntries).toHaveLength(helperEntries);
  expect(expected.offerCount).toBe(offerNodes.length);
  expect(expected.dataEntryCount).toBe(dataNames.length);
  expect(expected.recordedSigners).toHaveLength(signersAdded);

  // The close of these entries: a return and a removal per trustline, one operation per offer,
  // data entry and signer. The scenarios must declare exactly that, and the verifier's ceiling
  // must allow exactly that plus the threshold reset and the merge.
  const closeOps =
    2 * (trustlines.length + arriving.length) +
    offerNodes.length +
    dataNames.length +
    signersAdded +
    helperEntries;
  expect(plan.expectation.closeOperations).toBe(closeOps);
  expect(maxOperations(expected)).toBe(closeOps + 2);

  // A transfer goes to the account the session created for it, which trusts exactly the assets
  // the session transfers, and a conversion is held to the amount the mess paid in.
  const transferred = plan.expectation.dispositions.filter((d) => d.choice === "transfer");
  expect(recipientsCreated).toBe(transferred.length > 0 ? 1 : 0);
  expect(recipientTrusts).toEqual(transferred.map((d) => d.asset));
  expect(
    expected.transfers.map((t): { code: string; destination: string | null; amount: string } => ({
      code: t.asset.split(":")[0],
      destination: t.destination,
      amount: t.amount,
    }))
  ).toEqual(transferred.map((d) => ({ code: d.asset, destination: recipient, amount: d.amount })));
  expect(expected.conversions.map((c) => [c.asset.split(":")[0], c.amount])).toEqual(
    plan.expectation.dispositions
      .filter((d) => d.choice === "convert")
      .map((d) => [d.asset, d.amount])
  );
}

function* customConfigs(): Generator<PlaygroundCustomConfig> {
  for (let trustlineCount = 1; trustlineCount <= 5; trustlineCount++) {
    for (let offerCount = 0; offerCount <= maxOfferCount(trustlineCount); offerCount++) {
      for (let dataEntryCount = 0; dataEntryCount <= 5; dataEntryCount++) {
        for (const addSigner of [false, true]) {
          yield { trustlineCount, offerCount, dataEntryCount, addSigner };
        }
      }
    }
  }
}

/** The scenarios at the given positions of the registry, each parameter at its minimum or maximum. */
function selectionOf(mask: number, end: "min" | "max"): ScenarioSelection {
  return {
    scenarios: SCENARIOS.filter((_, i) => mask & (1 << i)).map((def) => ({
      id: def.id,
      params: Object.fromEntries(
        Object.entries(def.params).map(([name, spec]) => [name, spec[end]])
      ),
    })),
  };
}

const popcount = (mask: number): number => {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
};

/**
 * The scenarios that change only where the close goes: no mess step and no cost at any parameter
 * (today the exchange deposit). Read from the registry, so a new one is found without naming it.
 */
const DESTINATION_ONLY_MASK = SCENARIOS.reduce((mask, def, i) => {
  const builds = (["min", "max"] as const).map((end) =>
    def.build(
      Object.fromEntries(Object.entries(def.params).map(([name, spec]) => [name, spec[end]])),
      { heldAssets: [] }
    )
  );
  const destinationOnly = builds.every(
    (b) =>
      b.ok &&
      b.build.steps.length === 0 &&
      b.build.cost.xlm === 0 &&
      b.build.cost.subEntries === 0 &&
      b.build.cost.classicTransactions + b.build.cost.sorobanTransactions === 0
  );
  return destinationOnly ? mask | (1 << i) : mask;
}, 0);

/**
 * Every accepted single scenario, pair and triple, and every largest accepted selection, each with
 * every parameter at its minimum and then its maximum. Only validation sweeps every subset; the
 * cases actually run grow polynomially with the registry.
 *
 * A destination-only scenario (DESTINATION_ONLY_MASK) changes only the close's destination and
 * memo, which the singles, pairs and triples already exercise beside every other scenario. The
 * largest selections exist to reach the cost caps, and these scenarios cost nothing, so as members
 * they would only double that sweep for each one the registry gains. They are left out of it:
 * a largest selection is one no other scenario can join, and each is then run once more with
 * every destination-only scenario added that still fits it.
 */
function* registrySelections(): Generator<ScenarioSelection> {
  const all = 1 << SCENARIOS.length;
  const destinationOnly = SCENARIOS.map((_, i) => 1 << i).filter(
    (bit) => DESTINATION_ONLY_MASK & bit
  );
  for (const end of ["min", "max"] as const) {
    const valid = new Uint8Array(all);
    for (let mask = 1; mask < all; mask++) {
      valid[mask] = validateSelection(selectionOf(mask, end)).ok ? 1 : 0;
    }
    const yielded = new Set<number>();
    const emit = (mask: number): ScenarioSelection | null => {
      if (yielded.has(mask)) return null;
      yielded.add(mask);
      return selectionOf(mask, end);
    };
    for (let mask = 1; mask < all; mask++) {
      if (valid[mask] && popcount(mask) <= 3) yield emit(mask)!;
    }
    for (let mask = 1; mask < all; mask++) {
      if (!valid[mask] || mask & DESTINATION_ONLY_MASK) continue;
      const largest = SCENARIOS.every(
        (_, i) => mask & (1 << i) || DESTINATION_ONLY_MASK & (1 << i) || !valid[mask | (1 << i)]
      );
      if (!largest) continue;
      const alone = emit(mask);
      if (alone) yield alone;
      let joined = mask;
      for (const bit of destinationOnly) if (valid[joined | bit]) joined |= bit;
      if (joined !== mask) {
        const withDestination = emit(joined);
        if (withDestination) yield withDestination;
      }
    }
  }
}

describe("the plan, the chain and the close expectation agree", () => {
  for (const mode of ["light", "standard", "full"] as const satisfies PlaygroundMode[]) {
    test(`${mode} mode`, async () => {
      await runAndCheck(selectionForMode(mode));
    });
  }

  test("every custom configuration", async () => {
    let cases = 0;
    for (const config of customConfigs()) {
      await runAndCheck(selectionForMode("custom", config));
      cases++;
    }
    expect(cases).toBe(240);
  }, 120_000);

  test("every disposition of each disposition asset", async () => {
    for (let lwcoin = 0; lwcoin <= 2; lwcoin++) {
      for (let lwgem = 0; lwgem <= 2; lwgem++) {
        await runAndCheck({ scenarios: [{ id: "dispositions", params: { lwcoin, lwgem } }] });
      }
    }
  });

  test("every claimable-balance mix and every sponsored-reserve variant", async () => {
    for (let mix = 0; mix < 8; mix++) {
      const [add_trustline, time_gated, demo_sponsored] = [mix & 1, (mix >> 1) & 1, (mix >> 2) & 1];
      await runAndCheck({
        scenarios: [
          { id: "claimable-balances", params: { add_trustline, time_gated, demo_sponsored } },
        ],
      });
    }
    for (let variant = 0; variant <= 2; variant++) {
      await runAndCheck({ scenarios: [{ id: "sponsored-reserves", params: { variant } }] });
    }
    for (let variant = 0; variant <= 2; variant++) {
      await runAndCheck({ scenarios: [{ id: "multisig", params: { variant } }] });
    }
  });

  test("the destination-only scenarios are read from the registry", () => {
    const ids = SCENARIOS.filter((_, i) => DESTINATION_ONLY_MASK & (1 << i)).map((d) => d.id);
    expect(ids).toEqual(["exchange-close"]);
  });

  test("every pair and triple of scenarios and every largest accepted selection, at their smallest and largest parameters", async () => {
    let cases = 0;
    for (const selection of registrySelections()) {
      await runAndCheck(selection);
      cases++;
    }
    // The accepted singles, pairs, triples and largest selections at both parameter extremes, each
    // largest one also with the destination-only scenarios that fit it; pinned so a change to the
    // registry or its rules shows up here.
    expect(cases).toBe(7000);
  }, 240_000);
});
