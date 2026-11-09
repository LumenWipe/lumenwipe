import { expect, test } from "@playwright/test";
import { closeWith, count } from "./close-with";

// The claimable-balance and sponsored-reserve scenarios end to end on testnet, including the
// blocker-then-resolve story: a balance the demo created, or a sponsorship its beneficiary cannot
// take over, stops the close with a blocker card; "Resolve it" clears it with the helper's own key
// and the close completes into the market maker.

test("claimable balances: claim, add a trustline then claim, forfeit, and resolve the one the demo created", async ({
  page,
}) => {
  test.setTimeout(12 * 60_000);
  const { ops } = await closeWith(
    page,
    {
      scenarios: [
        {
          id: "claimable-balances",
          params: { add_trustline: 1, time_gated: 1, demo_sponsored: 1 },
        },
      ],
    },
    "Claimable balances",
    /claimable balance for another account/
  );
  // The two balances the demo can claim now; the time-gated one is forfeited.
  expect(count(ops, "claim_claimable_balance")).toBe(2);
});

for (const [variant, label, blocker, revokes] of [
  [0, "a sponsor pays the demo's reserves", null, 0],
  [1, "the demo's sponsorships are revoked", null, 2],
  [2, "an unrevocable sponsorship is resolved by its beneficiary", /cannot afford/, 0],
] as const) {
  test(`sponsored reserves: ${label}`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const { ops } = await closeWith(
      page,
      { scenarios: [{ id: "sponsored-reserves", params: { variant } }] },
      "Sponsored reserves",
      blocker
    );
    expect(count(ops, "revoke_sponsorship")).toBe(revokes);
  });
}
