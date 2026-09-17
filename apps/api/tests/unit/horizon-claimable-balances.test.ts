/**
 * Regression for a real mainnet 500: Horizon's public retention window (~1 year) drops the
 * ledger a claimable balance was created in, and reports `last_modified_time: null` for it
 * instead of a real date - observed live for four spam-airdrop balances (all unconditional /
 * abs_before) on an account with claimable balances from ledgers ~40M-49M. Confirmed from a
 * Cloud Run log: `AccountController.account` failing with "has an unusable last_modified_time
 * (null); claim predicates cannot be evaluated against it," thrown unconditionally for every
 * claimable balance regardless of whether its predicate ever needed that anchor.
 */
import { test, expect } from "bun:test";
import { fetchClaimableBalancesForClaimant } from "@/lib/stellar/horizon-adapter";

const BASE = "https://horizon.example";
const CLAIMANT = "GBXIT5W7J7BWYPAZUPFV3RHDVGD5EKIIHKTSYOL5GSADD3YGMIHPLNQX";

function stubHorizon(records: unknown[]) {
  const fetch = (async () =>
    new Response(JSON.stringify({ _embedded: { records } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  return { baseUrl: BASE, fetch };
}

test("a null last_modified_time no longer fails the read when no predicate needs it as an anchor", async () => {
  const deps = stubHorizon([
    {
      id: "0000000071e03e79",
      asset: "TRUTHSOCIAL:GABC",
      amount: "1.0000000",
      last_modified_time: null,
      claimants: [{ destination: CLAIMANT, predicate: { unconditional: true } }],
    },
    {
      id: "0000000082f04f80",
      asset: "trumpcoin:GDEF",
      amount: "1.0000000",
      last_modified_time: null,
      claimants: [{ destination: CLAIMANT, predicate: { abs_before: "2030-01-01T00:00:00Z" } }],
    },
  ]);

  const balances = await fetchClaimableBalancesForClaimant(CLAIMANT, deps);

  expect(balances).toHaveLength(2);
  expect(balances[0]!.claimants[0]!.predicate).toEqual({ type: "unconditional" });
  expect(balances[1]!.claimants[0]!.predicate).toEqual({
    type: "before_absolute_time",
    absBeforeEpoch: String(Math.floor(Date.parse("2030-01-01T00:00:00Z") / 1000)),
  });
});

test("a null last_modified_time still fails the read for the one predicate that actually needs it", async () => {
  const deps = stubHorizon([
    {
      id: "0000000071e03e79",
      asset: "SHIFT:GABC",
      amount: "1.0000000",
      last_modified_time: null,
      claimants: [{ destination: CLAIMANT, predicate: { rel_before: "3600" } }],
    },
  ]);

  await expect(fetchClaimableBalancesForClaimant(CLAIMANT, deps)).rejects.toThrow(
    /no creation time to anchor/
  );
});
