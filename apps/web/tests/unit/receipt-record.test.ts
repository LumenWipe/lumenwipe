import { expect, test } from "bun:test";
import {
  buildReceiptGroups,
  buildReceiptRecord,
  confirmedFeeLumens,
  outcomeOf,
  type ReceiptSource,
} from "@/lib/receipt/build-record";
import type { AccountState, Trustline } from "@/types/account";
import type { PlannedStep, StepStatus, StepType } from "@/types/plan";
import { RECORD_VERSION } from "@/types/session";
import { freshAccount } from "./fixtures/fresh-plan";

const SOURCE = "GSOURCE00000000000000000000000000000000000000000000000000";
const DEST = "GDESTINATION000000000000000000000000000000000000000000000";
const THIRD = "GTHIRDPARTY0000000000000000000000000000000000000000000000";
const ISSUER = "GISSUER000000000000000000000000000000000000000000000000000";

function step(
  index: number,
  type: StepType,
  status: StepStatus,
  over: Partial<PlannedStep> = {}
): PlannedStep {
  return {
    index,
    type,
    title: `${type} title`,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status,
    txHash: status === "confirmed" ? `hash${index}` : null,
    error: null,
    ...(status === "confirmed" ? { actualFeeLumens: "0.0000100" } : {}),
    ...over,
  };
}

function trustline(code: string, balance: string): Trustline {
  return {
    asset: `${code}:${ISSUER}`,
    balance,
    authorized: true,
    authorization: "authorized",
    clawbackEnabled: false,
    issuer: ISSUER,
    code,
  };
}

function source(over: Partial<ReceiptSource> = {}): ReceiptSource {
  return {
    executionPlan: [step(0, "MERGE", "confirmed")],
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    mediatorRequired: false,
    accountState: null,
    assetDispositions: {},
    transferDestinations: {},
    claimableBalanceSelections: {},
    ...over,
  };
}

const ID = { id: "r1", network: "testnet" as const, completedAt: "2026-11-07T10:00:00.000Z" };

test("the outcome is closed only when a merge step confirmed", () => {
  expect(outcomeOf([step(0, "MERGE", "confirmed")])).toBe("closed");
  expect(outcomeOf([step(0, "CLOSE_ACCOUNT", "confirmed")])).toBe("closed");
  expect(outcomeOf([step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "failed")])).toBe(
    "incomplete"
  );
  expect(outcomeOf([step(0, "MERGE", "confirmed", { txHash: null })])).toBe("incomplete");
});

test("fees count confirmed transactions only, and are not recorded when one lacks its fee", () => {
  expect(
    confirmedFeeLumens([
      step(0, "CANCEL_OFFERS", "confirmed", { actualFeeLumens: "0.0000200" }),
      step(1, "MERGE", "confirmed", { actualFeeLumens: "0" }),
      step(2, "MERGE", "pending"),
    ])
  ).toBe("0.0000200");
  expect(confirmedFeeLumens([step(0, "MERGE", "confirmed", { actualFeeLumens: undefined })])).toBe(
    null
  );
});

test("the record holds the close as plain data, with the amount left for the lookup", () => {
  const record = buildReceiptRecord(
    source({
      memo: "4242",
      memoType: "id",
      mediatorRequired: true,
      executionPlan: [
        step(0, "CANCEL_OFFERS", "confirmed", { txHash: "a" }),
        step(1, "REMOVE_TRUSTLINES", "confirmed", { txHash: "a" }),
        step(2, "MERGE", "confirmed", { txHash: "b" }),
        step(3, "MERGE", "pending"),
      ],
    }),
    ID
  );

  expect(record).toMatchObject({
    version: RECORD_VERSION,
    id: "r1",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    mediatorRequired: true,
    outcome: "closed",
    completedAt: "2026-11-07T10:00:00.000Z",
    memo: { text: "4242", type: "id" },
    feeLumens: "0.0000300",
    receivedLumens: null,
  });
  expect(record?.transactions.map((t) => [t.txHash, t.stepTypes])).toEqual([
    ["a", ["CANCEL_OFFERS", "REMOVE_TRUSTLINES"]],
    ["b", ["MERGE"]],
  ]);
  expect(JSON.parse(JSON.stringify(record))).toEqual(record);
});

test("the record has exactly the receipt's fields, whatever else the store holds", () => {
  const extra = {
    ...source(),
    secretKey: "SSECRET",
    signerKey: "SSIGNER",
    unconfirmedSubmission: { envelope: "AAAAENVELOPE" },
  } as ReceiptSource;
  const record = buildReceiptRecord(extra, ID)!;
  expect(Object.keys(record).sort()).toEqual(
    [
      "completedAt",
      "destinationAddress",
      "feeLumens",
      "groups",
      "id",
      "mediatorRequired",
      "memo",
      "network",
      "outcome",
      "receivedLumens",
      "sourceAddress",
      "transactions",
      "version",
    ].sort()
  );
  const json = JSON.stringify(record);
  for (const leak of ["SSECRET", "SSIGNER", "AAAAENVELOPE", "txXdr"]) {
    expect(json).not.toContain(leak);
  }
});

test("no record is built without the addresses of the close", () => {
  expect(buildReceiptRecord(source({ sourceAddress: null }), ID)).toBeNull();
  expect(buildReceiptRecord(source({ destinationAddress: null }), ID)).toBeNull();
});

test("the groups say what was done, as plain data", () => {
  const account: AccountState = freshAccount(SOURCE, {
    signers: [
      { key: SOURCE, weight: 1, type: "ed25519_public_key" },
      { key: THIRD, weight: 2, type: "ed25519_public_key" },
    ],
    dataEntries: [{ key: "config", value: "" }],
    claimableBalances: [
      { id: "kept", asset: "native", amount: "5", claimants: [], sponsor: null },
      { id: "gone", asset: "native", amount: "7", claimants: [], sponsor: null },
    ],
    trustlines: [trustline("USDC", "10"), trustline("BURN", "1"), trustline("NOPE", "0")],
  });
  const groups = buildReceiptGroups(
    source({
      accountState: account,
      claimableBalanceSelections: { gone: "forfeit" },
      assetDispositions: { [`USDC:${ISSUER}`]: "transfer", [`BURN:${ISSUER}`]: "issuer" },
      transferDestinations: { [`USDC:${ISSUER}`]: THIRD },
    }),
    "closed"
  );

  const byType = Object.fromEntries(groups.map((g) => [g.type, g]));
  expect(byType.NORMALIZE_SIGNERS.items).toEqual([
    { text: "GTHIRDPA…00000000", detail: "weight 2", mono: true },
  ]);
  expect(byType.REMOVE_DATA_ENTRIES.items).toEqual([{ text: "config", mono: true }]);
  // A forfeited balance was never claimed.
  expect(byType.CLAIM_BALANCES.items).toEqual([{ text: "5 XLM" }]);
  expect(byType.HANDLE_ASSETS.items.map((i) => i.text)).toEqual([
    "USDC → sent to GTHIRDPA…00000000",
    "BURN → returned to issuer",
  ]);
  expect(byType.REMOVE_TRUSTLINES.summary).toBe("3 trustlines");
  expect(byType.MERGE.note).toContain("removed from the Stellar ledger");
  expect(JSON.parse(JSON.stringify(groups))).toEqual(groups);
});

test("an incomplete close has no merge group", () => {
  const groups = buildReceiptGroups(
    source({ executionPlan: [step(0, "CANCEL_OFFERS", "confirmed")] }),
    "incomplete"
  );
  expect(groups.map((g) => g.type)).not.toContain("MERGE");
});

test("a relay merge says so", () => {
  const [merge] = buildReceiptGroups(source({ mediatorRequired: true }), "closed");
  expect(merge.summary).toBe("via relay account to GDESTINA…00000000");
  expect(merge.note).toContain("relay account");
});
