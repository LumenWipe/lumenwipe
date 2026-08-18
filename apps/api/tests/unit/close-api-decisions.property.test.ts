import { test } from "bun:test";
import fc from "fast-check";
import { resolveClaimableBalanceSelections, resolveDispositions } from "@/lib/close-api/decisions";
import type { AssetDisposition, ClaimableBalanceSelection, DecisionAnswer } from "@lumenwipe/types";

// These two functions turn an unvalidated `decisions` array from the request body into the
// record the transaction builder trusts. The invariant that matters for correctness (and, given
// what a close does, for safety) isn't any single example - it's that no combination of answers
// can smuggle in an entry the function shouldn't produce: an id that names something the caller
// never asked about, or a choice value the domain doesn't recognize. Example-based tests pin a
// handful of cases; this fuzzes the input space directly against that invariant.

const arbAssetId = fc.string({ minLength: 1, maxLength: 8 }).map((s) => `asset:${s}`);
const arbBalanceId = fc.string({ minLength: 1, maxLength: 8 });
const arbChoice = fc.oneof(
  fc.constantFrom(
    "convert_to_xlm",
    "return_to_issuer",
    "claim",
    "add_trustline_then_claim",
    "forfeit"
  ),
  fc.string()
);

const arbAnswer: fc.Arbitrary<DecisionAnswer> = fc.record({
  id: fc.oneof(
    arbAssetId,
    arbBalanceId.map((id) => `claim:${id}`),
    fc.string()
  ),
  choice: arbChoice,
});

test("resolveDispositions never emits an asset outside the known set or a choice outside the domain", () => {
  fc.assert(
    fc.property(
      fc.array(arbAnswer, { maxLength: 20 }),
      fc.array(arbAssetId, { maxLength: 10 }),
      (answers, knownIds) => {
        const assetsById = knownIds.map((id) => ({ id, asset: id.slice("asset:".length) }));
        const knownAssets = new Set(assetsById.map((a) => a.asset));
        const validChoices: AssetDisposition[] = ["convert", "issuer"];

        const result = resolveDispositions(answers, assetsById);

        for (const [asset, disposition] of Object.entries(result)) {
          if (!knownAssets.has(asset)) {
            throw new Error(`resolveDispositions produced an unknown asset key: ${asset}`);
          }
          if (!validChoices.includes(disposition)) {
            throw new Error(`resolveDispositions produced an invalid disposition: ${disposition}`);
          }
        }
      }
    )
  );
});

test("resolveClaimableBalanceSelections never emits a balance id outside the known set or an unrecognized selection", () => {
  fc.assert(
    fc.property(
      fc.array(arbAnswer, { maxLength: 20 }),
      fc.array(arbBalanceId, { maxLength: 10 }),
      (answers, knownBalanceIds) => {
        const known = new Set(knownBalanceIds);
        const validSelections: ClaimableBalanceSelection[] = [
          "claim",
          "add_trustline_then_claim",
          "forfeit",
        ];

        const result = resolveClaimableBalanceSelections(answers, knownBalanceIds);

        for (const [balanceId, selection] of Object.entries(result)) {
          if (!known.has(balanceId)) {
            throw new Error(
              `resolveClaimableBalanceSelections produced an unknown balance id: ${balanceId}`
            );
          }
          if (!validSelections.includes(selection)) {
            throw new Error(
              `resolveClaimableBalanceSelections produced an invalid selection: ${selection}`
            );
          }
        }
      }
    )
  );
});

test("resolveDispositions touches exactly the assets with a valid-choice answer, regardless of answer order", () => {
  fc.assert(
    fc.property(
      fc.array(arbAnswer, { maxLength: 15 }),
      fc.array(arbAssetId, { maxLength: 8 }),
      (answers, knownIds) => {
        const assetsById = knownIds.map((id) => ({ id, asset: id.slice("asset:".length) }));
        const forward = new Set(Object.keys(resolveDispositions(answers, assetsById)));
        const reversed = new Set(
          Object.keys(resolveDispositions([...answers].reverse(), assetsById))
        );

        // Which asset ends up touched depends only on whether some answer matched it with a
        // recognized choice, not on the order the answers arrived in - only the winning choice
        // for a given asset (last one wins) may differ, never the key set itself.
        if (forward.size !== reversed.size || [...forward].some((k) => !reversed.has(k))) {
          throw new Error("reversing answer order changed which assets were touched");
        }
      }
    )
  );
});
