import { expect, test } from "./timed";
import { phoenixReads, phoenixSwapFits } from "../../lib/phoenix-pool";
import { networkStroops } from "../../lib/stroops";
import {
  AQUARIUS_SEED,
  encodeSelection,
  FEATURE_SETS,
  parseUnavailable,
  PHOENIX_SEED,
  presetSelection,
  SCENARIOS,
  SOROSWAP_SEED,
  type FeatureSetId,
  type ScenarioId,
  type ScenarioSelection,
} from "../../lib/scenarios";
import { closeOnScreen, relay } from "./close-with";
import { dexSellsUsdc } from "./testnet";

// Each feature set's preset end to end on testnet, as this deployment offers it tonight: every
// scenario of the set it can run, closed through the real API to the merge. The classic preset is
// the standard recipe, which full-cycle.spec.ts runs.

const BASE = "http://localhost:3002";
const SETS: readonly FeatureSetId[] = ["protocol", "api"];

/** Scenarios tonight's testnet markets cannot seed: the probes their own specs skip on. */
async function marketGaps(): Promise<Map<ScenarioId, string>> {
  const gaps = new Map<ScenarioId, string>();
  const noUsdc = "The testnet DEX sells no Circle USDC within the ceiling";
  if (!(await dexSellsUsdc(SOROSWAP_SEED))) gaps.set("soroswap-lp", noUsdc);
  if (!(await dexSellsUsdc(AQUARIUS_SEED))) gaps.set("aquarius-lp", noUsdc);
  const quote = await phoenixReads().swapQuote(networkStroops(PHOENIX_SEED.swapXlm));
  if (!phoenixSwapFits(quote)) {
    gaps.set("phoenix-lp", "The testnet Phoenix pool cannot sell LWPHX within the gate");
  }
  return gaps;
}

/** The set's preset over what the deployment offers and the markets can seed; null if nothing. */
async function tonight(
  set: FeatureSetId
): Promise<{ selection: ScenarioSelection; gaps: Map<ScenarioId, string> } | null> {
  const res = await fetch(`${BASE}/api/scenarios`);
  expect(res.ok).toBe(true);
  const unavailable = parseUnavailable(await res.json());
  const gaps = await marketGaps();
  const selection = presetSelection(set, { unavailable: new Map([...unavailable, ...gaps]) });
  return selection && { selection, gaps };
}

test("at least one preset can run on testnet tonight", async () => {
  const runnable = await Promise.all(SETS.map(tonight));
  expect(
    runnable.some((run) => run !== null),
    "every preset would be skipped, so none would be tested"
  ).toBe(true);
});

for (const set of SETS) {
  const { label } = FEATURE_SETS.find((s) => s.id === set)!;

  test(`the ${label} preset closes end to end`, async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const run = await tonight(set);
    test.skip(run === null, `Nothing in ${label} can run on testnet tonight`);
    const { selection, gaps } = run!;
    for (const [id, reason] of gaps) {
      test.info().annotations.push({ type: "left out", description: `${id}: ${reason}` });
    }

    await page.goto(`/?selection=${encodeSelection(selection)}`);
    for (const choice of selection.scenarios) {
      const scenario = SCENARIOS.find((s) => s.id === choice.id)!.label;
      await expect(page.getByRole("button", { name: scenario, pressed: true })).toBeVisible();
    }
    const intoExchange = selection.scenarios.some((c) => c.id === "exchange-close");
    await closeOnScreen(page, null, intoExchange ? relay : undefined);
  });
}
