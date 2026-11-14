import { expect, test } from "./timed";
import { closeWith } from "./close-with";

// The multi-signature scenario end to end on testnet, one test per variant. The mess raises every
// threshold to 2, so the master key alone cannot close the account: the close removes the other
// signers first, signed with the recorded co-signer key or the hash(x) preimage, then merges. The
// dormant pre-authorized transaction signer can never sign and is simply removed.

for (const [variant, label, prefixes] of [
  [0, "two of three keys", ["G", "G"]],
  [1, "the master key and a hash(x) signer", ["X"]],
  [2, "two of three keys and a dormant pre-authorized transaction", ["G", "G", "T"]],
] as const) {
  test(`multi-signature account: ${label}`, async ({ page }) => {
    test.setTimeout(8 * 60_000);
    const { ops } = await closeWith(
      page,
      { scenarios: [{ id: "multisig", params: { variant } }] },
      "Multi-signature account",
      null
    );
    const setOptions = ops.filter((op) => op.type === "set_options");
    const added = setOptions.filter((op) => op.signer_key && op.signer_weight === 1);
    const removed = setOptions.filter((op) => op.signer_key && op.signer_weight === 0);
    const prefix = (op: { signer_key?: string }) => op.signer_key?.[0];
    expect(added.map(prefix).sort()).toEqual([...prefixes].sort());
    expect(removed.map((op) => op.signer_key).sort()).toEqual(
      added.map((op) => op.signer_key).sort()
    );
    expect(setOptions).toContainEqual(
      expect.objectContaining({ low_threshold: 2, med_threshold: 2, high_threshold: 2 })
    );
    // The removals and the reset land before the merge, the last operation (closeWith).
    const reset = setOptions.findIndex(
      (op) => op.low_threshold === 0 && op.med_threshold === 1 && op.high_threshold === 1
    );
    expect(reset).toBeGreaterThan(-1);
  });
}
