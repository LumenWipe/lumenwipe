import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { deriveDecisionPoints } from "@/lib/close-api/decisions";
import { readTrustlinesOnly } from "@/lib/stellar/account-state";
import { assessTrustlineAuthorizationBlockers, buildPlan } from "@/lib/stellar/tx-builder";
import { UnusableProviderResponseError } from "@/lib/utils/errors";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

function line(
  authorization: Trustline["authorization"],
  balance: string,
  clawbackEnabled = false
): Trustline {
  return {
    asset: `USDC:${ISSUER}`,
    balance,
    authorized: authorization === "authorized",
    authorization,
    clawbackEnabled,
    issuer: ISSUER,
    code: "USDC",
    limit: "1000",
  };
}

function state(trustlines: Trustline[]): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: trustlines.length,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines,
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

afterEach(() => {
  mock.restore();
});

test("an unauthorized line with a balance is a coded blocker with the existing copy", () => {
  const [blocker] = assessTrustlineAuthorizationBlockers([line("unauthorized", "5")]);
  expect(blocker).toEqual({
    code: "trustline_deauthorized_with_balance",
    message:
      "Trustline for USDC has a non-zero balance (5) but is deauthorized by the issuer. The " +
      "issuer must re-authorize this trustline before it can be converted or removed.",
  });
});

test("a maintain-liabilities line with a balance gets its own code and copy", () => {
  const [blocker] = assessTrustlineAuthorizationBlockers([line("maintain_liabilities", "5")]);
  expect(blocker!.code).toBe("trustline_maintain_liabilities_with_balance");
  expect(blocker!.message).toContain("keeping existing offers only");
  expect(blocker!.message).not.toContain("deauthorized");
});

test("authorized lines and empty restricted lines raise nothing", () => {
  expect(
    assessTrustlineAuthorizationBlockers([
      line("authorized", "5"),
      line("unauthorized", "0"),
      line("maintain_liabilities", "0.0000000"),
    ])
  ).toEqual([]);
});

const PARITY_CASES: Array<[Trustline["authorization"], string, string | null]> = [
  ["authorized", "5", null],
  ["authorized", "0", null],
  ["unauthorized", "5", "trustline_deauthorized_with_balance"],
  ["unauthorized", "0", null],
  ["maintain_liabilities", "5", "trustline_maintain_liabilities_with_balance"],
  ["maintain_liabilities", "0", null],
];

test.each(PARITY_CASES)(
  "plan and build agree on a %s line holding %s",
  async (authorization, balance, expectedCode) => {
    const account = state([line(authorization, balance)]);
    const planCodes = buildPlan(account, false, false)
      .blockers.map((b) => b.code)
      .filter((c) => c?.startsWith("trustline_"));
    expect(planCodes).toEqual(expectedCode ? [expectedCode] : []);

    const liveRead = new Error("reached the live read");
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getAccount: () => {
        throw liveRead;
      },
      getLatestLedger: () => {
        throw liveRead;
      },
    })) as unknown as typeof rpcModule.getRpcServer);

    const err = await buildCloseTransactions(account, DEST, {}, "testnet").catch((e: unknown) => e);
    if (expectedCode) {
      expect(err).toBeInstanceOf(CloseBuildError);
      expect((err as CloseBuildError).code).toBe(expectedCode as CloseBuildError["code"]);
      expect((err as CloseBuildError).status).toBe(422);
    } else {
      expect(err).toBe(liveRead);
    }
  }
);

test("an asset decision carries the line's authorization state and clawback flag", () => {
  const [point] = deriveDecisionPoints(state([line("authorized", "5", true)]), {
    [`USDC:${ISSUER}`]: true,
  });
  expect(point!.subject).toMatchObject({ authorization: "authorized", clawbackEnabled: true });
});

function fetchOf(balance: Record<string, unknown>): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ balances: [balance] }), {
      status: 200,
    })) as unknown as typeof globalThis.fetch;
}

const HORIZON_CREDIT_LINE = {
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: ISSUER,
  balance: "10.0000000",
  limit: "922337203685.4775807",
  buying_liabilities: "0.0000000",
  selling_liabilities: "0.0000000",
  is_authorized: true,
  is_authorized_to_maintain_liabilities: true,
};

test("a Horizon-shaped line that omits is_clawback_enabled reads as not clawback-enabled", async () => {
  const read = await readTrustlinesOnly(SOURCE, "testnet", {
    baseUrl: "https://horizon.example",
    fetch: fetchOf(HORIZON_CREDIT_LINE),
  });
  expect(read!.trustlines[0]).toMatchObject({
    authorization: "authorized",
    authorized: true,
    clawbackEnabled: false,
  });
});

test("a line that sets is_clawback_enabled reads as clawback-enabled", async () => {
  const read = await readTrustlinesOnly(SOURCE, "testnet", {
    baseUrl: "https://horizon.example",
    fetch: fetchOf({ ...HORIZON_CREDIT_LINE, is_clawback_enabled: true }),
  });
  expect(read!.trustlines[0]!.clawbackEnabled).toBe(true);
});

test("a destination line with no is_authorized fails the read instead of reading as authorized", async () => {
  const { is_authorized: _omit, ...withoutAuth } = HORIZON_CREDIT_LINE; // eslint-disable-line @typescript-eslint/no-unused-vars
  const err = await readTrustlinesOnly(SOURCE, "testnet", {
    baseUrl: "https://horizon.example",
    fetch: fetchOf(withoutAuth),
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnusableProviderResponseError);
});

test("a destination's config.memo_required data entry is read from the same account response", async () => {
  const withData = (data: Record<string, string> | undefined) =>
    (async () =>
      new Response(JSON.stringify({ balances: [HORIZON_CREDIT_LINE], data }), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
  const read = (data: Record<string, string> | undefined) =>
    readTrustlinesOnly(DEST, "testnet", {
      baseUrl: "https://horizon.example",
      fetch: withData(data),
    });
  expect((await read({ "config.memo_required": "MQ==" }))!.memoRequired).toBe(true);
  expect((await read({ "config.memo_required": "MA==" }))!.memoRequired).toBe(false);
  expect((await read({}))!.memoRequired).toBe(false);
  expect((await read(undefined))!.memoRequired).toBe(false);
});
