import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Keypair } from "@stellar/stellar-sdk";
import type { AccountState, OpenOffer, Trustline } from "@lumenwipe/types";
import * as pathFinding from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { ALL_ON } from "@/config/kill-switches";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { ledgerEntries } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { authorizationOf } from "./fixtures/trustline";

// The transactions this builder produces for the playground's recipes, kept as a fixture that
// apps/playground's unit tests run through the playground's verifier
// (apps/playground/tests/unit/verify.test.ts). A builder change that alters them fails here until
// the fixture is regenerated, and the regenerated fixture then has to pass the playground's
// verifier, so the playground cannot silently start refusing the closes this API builds for it.
//
// Regenerate: UPDATE_PLAYGROUND_RECIPE=1 bun test tests/unit/playground-recipe.test.ts, then
// bun run format from the repository root.

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../playground/tests/fixtures/api-recipe-close.json", import.meta.url)
);
const UPDATE = process.env.UPDATE_PLAYGROUND_RECIPE === "1";

// Fixed, so the envelopes are byte-identical run to run.
const BUILT_AT_SECONDS = 1_800_000_000;
const key = (n: number): string => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();
const DEMO = key(1);
const SINK = key(2);
const LWDEMO_ISSUER = key(3);
const FORGOTTEN_SIGNER = key(4);
const EPHEMERAL = [
  { assetCode: "AIRDROP1", publicKey: key(5), balance: "1000000.0000000" },
  { assetCode: "RUGPULL", publicKey: key(6), balance: "13.3700000" },
  { assetCode: "DEMOUSD", publicKey: key(7), balance: "10.0000000" },
  { assetCode: "DEMOEUR", publicKey: key(8), balance: "10.0000000" },
];
const LWDEMO_BALANCE = "25.0000000";
const DATA_KEYS = ["promo_code", "legacy_app_state", "airdrop_claim", "referral_id", "kyc_status"];

interface Recipe {
  name: string;
  ephemeralCount: number;
  offerCount: number;
  dataEntryCount: number;
  addSigner: boolean;
}

// The playground's own modes (apps/playground/app/api/session/route.ts): light, full, and the
// largest custom configuration.
const RECIPES: Recipe[] = [
  { name: "light", ephemeralCount: 0, offerCount: 0, dataEntryCount: 0, addSigner: false },
  { name: "full", ephemeralCount: 4, offerCount: 5, dataEntryCount: 3, addSigner: true },
  { name: "custom-max", ephemeralCount: 4, offerCount: 5, dataEntryCount: 5, addSigner: true },
];

function trustline(code: string, issuer: string, balance: string): Trustline {
  return {
    asset: `${code}:${issuer}`,
    balance,
    limit: "922337203685.4775807",
    ...authorizationOf(true),
    issuer,
    code,
  };
}

function accountState(recipe: Recipe): AccountState {
  const ephemeral = EPHEMERAL.slice(0, recipe.ephemeralCount);
  const trustlines = [
    trustline("LWDEMO", LWDEMO_ISSUER, LWDEMO_BALANCE),
    ...ephemeral.map((e) => trustline(e.assetCode, e.publicKey, e.balance)),
  ];
  // Each offer sells the native balance or one of the demo's assets, as JUNK_OFFERS does.
  const openOffers: OpenOffer[] = Array.from({ length: recipe.offerCount }, (_, i) => ({
    id: String(i + 1),
    selling: i === 0 ? "native" : trustlines[i]!.asset,
    buying: i === 0 ? trustlines[0]!.asset : "native",
    amount: "1.0000000",
    price: "2",
  }));
  const signers = [{ key: DEMO, weight: 1, type: "ed25519_public_key" as const }];
  if (recipe.addSigner)
    signers.push({ key: FORGOTTEN_SIGNER, weight: 1, type: "ed25519_public_key" });
  return {
    address: DEMO,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "100.0000000",
    dataEntries: DATA_KEYS.slice(0, recipe.dataEntryCount).map((k) => ({ key: k, value: "eA==" })),
    signers,
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries:
      trustlines.length + openOffers.length + recipe.dataEntryCount + (recipe.addSigner ? 1 : 0),
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines,
    openOffers,
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(DEMO),
    defiPositionsWarnings: [],
  };
}

async function build(recipe: Recipe) {
  const state = accountState(recipe);
  const balances = new Map(state.trustlines.map((t) => [`${DEMO}|${t.asset}`, t.balance]));
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(DEMO, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: ledgerEntries((id) => {
      const balance = balances.get(id);
      return balance === undefined
        ? undefined
        : { balance: BigInt(Math.round(Number(balance) * 10_000_000)) };
    }),
  })) as unknown as typeof rpcModule.getRpcServer);
  const dispositions = Object.fromEntries(
    state.trustlines.map((t) => [t.asset, "issuer" as const])
  );
  const result = await buildCloseTransactions(ALL_ON, state, SINK, dispositions, "testnet");
  return {
    name: recipe.name,
    // The session record the playground would hold for this account.
    session: {
      demoPublic: DEMO,
      sinkPublic: SINK,
      lwdemoIssuer: LWDEMO_ISSUER,
      ephemeralIssuers: EPHEMERAL.slice(0, recipe.ephemeralCount).map(
        ({ assetCode, publicKey }) => ({ assetCode, publicKey })
      ),
      recordedSigners: recipe.addSigner ? [FORGOTTEN_SIGNER] : [],
      offerCount: recipe.offerCount,
      dataEntryCount: recipe.dataEntryCount,
    },
    transactions: result.transactions.map((tx) => tx.xdr),
  };
}

beforeEach(() => {
  setSystemTime(new Date(BUILT_AT_SECONDS * 1000));
  stubIssuance();
  stubLedgerConfirmation();
  // A return to the issuer needs no route; a lookup here would mean the recipe stopped using one.
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(() => {
    throw new Error("the playground recipe never converts");
  });
});

afterEach(() => {
  mock.restore();
  setSystemTime();
});

test("the playground recipes build the transactions in apps/playground's fixture", async () => {
  const recipes = [];
  for (const recipe of RECIPES) recipes.push(await build(recipe));
  const fixture = { builtAtSeconds: BUILT_AT_SECONDS, recipes };
  if (UPDATE) writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  expect(existsSync(FIXTURE_PATH)).toBe(true);
  // Compared as data, so `bun run format` may lay the file out as it likes. On a mismatch,
  // regenerate (see the top of this file), format, and run apps/playground's tests.
  expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(fixture);
});
