import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import * as pathFinding from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { ALL_ON } from "@/config/kill-switches";
import { xlmToStroops } from "@/lib/utils/amounts";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { authorizationOf } from "./fixtures/trustline";

// The transactions this builder produces for the playground's dispositions scenario, where each
// of its two tokens is burned, converted to XLM or transferred to the session's own recipient.
// apps/playground's unit tests run them through the playground's verifier
// (apps/playground/tests/unit/verify.test.ts), with the expectation that scenario plans, so a
// builder change that alters a conversion or a transfer fails one side or the other.
// apps/playground/tests/fixtures/api-recipe-close.json, the other recipes, is left as it was.
//
// Regenerate: UPDATE_PLAYGROUND_RECIPE=1 bun test tests/unit/playground-dispositions-recipe.test.ts,
// then bun run format from the repository root.

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../playground/tests/fixtures/api-recipe-dispositions.json", import.meta.url)
);
const UPDATE = process.env.UPDATE_PLAYGROUND_RECIPE === "1";

// Fixed, so the envelopes are byte-identical run to run.
const BUILT_AT_SECONDS = 1_800_000_000;
const key = (n: number): string => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey();
const DEMO = key(11);
const SINK = key(12);
const PERSISTENT_ISSUER = key(13);
const RECIPIENT = key(14);

// The playground's catalog (apps/playground/lib/scenarios/catalog.ts): what the mess pays in, and
// the market maker's standing price, in units per XLM.
const AMOUNTS = { LWCOIN: "20.0000000", LWGEM: "8.0000000" } as const;
const STANDING_PRICE = 2;

type Choice = "burn" | "convert" | "transfer";
const CHOICE_PARAM: Record<Choice, number> = { burn: 0, convert: 1, transfer: 2 };

interface Recipe {
  name: string;
  choices: Record<keyof typeof AMOUNTS, Choice>;
}

// Between them every choice, for each of the two tokens.
const RECIPES: Recipe[] = [
  { name: "convert-and-transfer", choices: { LWCOIN: "convert", LWGEM: "transfer" } },
  { name: "transfer-and-burn", choices: { LWCOIN: "transfer", LWGEM: "burn" } },
  { name: "burn-and-convert", choices: { LWCOIN: "burn", LWGEM: "convert" } },
];

const CODES = Object.keys(AMOUNTS) as (keyof typeof AMOUNTS)[];
const assetOf = (code: string): string => `${code}:${PERSISTENT_ISSUER}`;

function trustline(code: keyof typeof AMOUNTS): Trustline {
  return {
    asset: assetOf(code),
    balance: AMOUNTS[code],
    limit: "922337203685.4775807",
    ...authorizationOf(true),
    issuer: PERSISTENT_ISSUER,
    code,
  };
}

function accountState(): AccountState {
  return {
    address: DEMO,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "100.0000000",
    dataEntries: [],
    signers: [{ key: DEMO, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: CODES.length,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: CODES.map(trustline),
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(DEMO),
    defiPositionsWarnings: [],
  };
}

/** What Horizon's strict-send path answers for the market maker's standing offer. */
function standingRoute(asset: string, amount: string): pathFinding.PathResult {
  const received = (Number(amount) / STANDING_PRICE).toFixed(7);
  return {
    kind: "route",
    path: {
      fromAsset: asset,
      toAsset: "native",
      path: [],
      estimatedReceive: received,
      destMin: pathFinding.applySlippage(received),
    },
  };
}

async function build(recipe: Recipe) {
  const state = accountState();
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(DEMO, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    // The recipient trusts each token it is sent, with room for it.
    getLedgerEntries: mirrorSnapshot(
      DEMO,
      () => state.trustlines,
      Object.fromEntries(CODES.map((code) => [`${RECIPIENT}|${assetOf(code)}`, { balance: 0n }]))
    ),
  })) as unknown as typeof rpcModule.getRpcServer);
  const dispositions = Object.fromEntries(
    CODES.map((code) => {
      const choice = recipe.choices[code];
      return [assetOf(code), choice === "burn" ? ("issuer" as const) : choice];
    })
  );
  const transferDestinations = Object.fromEntries(
    CODES.filter((code) => recipe.choices[code] === "transfer").map((code) => [
      assetOf(code),
      RECIPIENT,
    ])
  );
  // The floor the playground answers with: the standing price, less 1%.
  const classicFloors = Object.fromEntries(
    CODES.filter((code) => recipe.choices[code] === "convert").map((code) => [
      assetOf(code),
      (BigInt(xlmToStroops(AMOUNTS[code])) * 99n) / (BigInt(STANDING_PRICE) * 100n),
    ])
  );
  const result = await buildCloseTransactions(
    ALL_ON,
    state,
    SINK,
    dispositions,
    "testnet",
    null,
    {},
    transferDestinations,
    {},
    {},
    { classicFloors }
  );
  return {
    name: recipe.name,
    // The registry selection the playground would hold for this session.
    selection: {
      scenarios: [
        {
          id: "dispositions",
          params: {
            lwcoin: CHOICE_PARAM[recipe.choices.LWCOIN],
            lwgem: CHOICE_PARAM[recipe.choices.LWGEM],
          },
        },
      ],
    },
    session: {
      demoPublic: DEMO,
      sinkPublic: SINK,
      persistentIssuer: PERSISTENT_ISSUER,
      transferRecipient: RECIPIENT,
    },
    transactions: result.transactions.map((tx) => tx.xdr),
  };
}

beforeEach(() => {
  setSystemTime(new Date(BUILT_AT_SECONDS * 1000));
  stubIssuance();
  stubLedgerConfirmation();
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(async (asset, amount) =>
    standingRoute(asset, amount)
  );
});

afterEach(() => {
  mock.restore();
  setSystemTime();
});

test("the dispositions recipes build the transactions in apps/playground's fixture", async () => {
  const recipes = [];
  for (const recipe of RECIPES) recipes.push(await build(recipe));
  const fixture = { builtAtSeconds: BUILT_AT_SECONDS, recipes };
  if (UPDATE) writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  expect(existsSync(FIXTURE_PATH)).toBe(true);
  // Compared as data, so `bun run format` may lay the file out as it likes. On a mismatch,
  // regenerate (see the top of this file), format, and run apps/playground's tests.
  expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(fixture);
});

test("each recipe is one transaction that converts, transfers and burns as it chose", async () => {
  for (const recipe of RECIPES) {
    const { transactions } = await build(recipe);
    expect(transactions).toHaveLength(1);
    const tx = TransactionBuilder.fromXDR(transactions[0]!, Networks.TESTNET);
    const shapes = tx.operations.map((op) => {
      if (op.type === "pathPaymentStrictSend") return ["convert", op.sendAsset.getCode()];
      if (op.type === "payment") {
        const to = op.destination === RECIPIENT ? "transfer" : op.destination;
        return [to === PERSISTENT_ISSUER ? "burn" : to, op.asset.getCode()];
      }
      return [op.type];
    });
    const chosen = CODES.map((code) => [recipe.choices[code], code]);
    expect(shapes).toEqual([...chosen, ["changeTrust"], ["changeTrust"], ["accountMerge"]]);
  }
});
