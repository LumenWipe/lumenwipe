import { expect, test } from "bun:test";
import {
  AIRDROP_ASSETS,
  DISPOSITION_ASSETS,
  JUNK_OFFERS,
  MESS_STEP_IDS,
  PERSISTENT_ASSETS,
  SCENARIOS,
  SWAP_ASSETS,
  type AssetCode,
} from "@/lib/scenarios";

// The playground issues its own assets on testnet. None may carry the code of a real stablecoin, so
// a visitor (or a screenshot of the demo) cannot take a throwaway token for the real asset. Circle's
// testnet USDC is the one real asset the playground holds, and it is pinned by issuer and labelled
// "USDC (Circle)" (lib/scenarios/pinned.ts), never issued here.

const REAL_STABLECOIN_CODES = [
  "USDC",
  "EURC",
  "USDT",
  "EURT",
  "PYUSD",
  "DAI",
  "USDP",
  "TUSD",
  "BUSD",
  "GUSD",
  "FDUSD",
  "USDS",
  "USDX",
  "EURX",
  "GBPX",
  "ARST",
  "BRZ",
];

/** Every trustline any scenario can open, so a scenario with offers builds all of them. */
const ALL_HELD: readonly AssetCode[] = SCENARIOS.flatMap((def) =>
  def.heldAssets(
    Object.fromEntries(Object.entries(def.params).map(([name, spec]) => [name, spec.max]))
  )
);

/** Every code a scenario opens a trustline to or trades, at each parameter's largest value. */
function issuedCodes(): string[] {
  const codes = new Set<string>([
    ...AIRDROP_ASSETS.map((a) => a.code),
    ...SWAP_ASSETS.map((a) => a.code),
    ...DISPOSITION_ASSETS.map((a) => a.code),
    ...PERSISTENT_ASSETS,
    ...JUNK_OFFERS.flatMap((o) => [o.selling, o.buying]).filter((c) => c !== "native"),
  ]);
  for (const def of SCENARIOS) {
    const params = Object.fromEntries(
      Object.entries(def.params).map(([name, spec]) => [name, spec.max])
    );
    const built = def.build(params, { heldAssets: ALL_HELD });
    if (!built.ok) throw new Error(`${def.id} does not build at its largest: ${built.message}`);
    for (const { step } of built.build.steps) {
      if (step.action.kind === "change_trust") codes.add(step.action.asset);
    }
    for (const code of built.build.ephemeralAssets) codes.add(code);
  }
  return [...codes];
}

test("no asset the playground issues carries a real stablecoin's code", () => {
  const codes = issuedCodes();
  expect(codes).toContain("DEMOUSD");
  expect(codes).toContain("DEMOEUR");
  for (const code of codes) {
    expect(REAL_STABLECOIN_CODES).not.toContain(code.toUpperCase());
  }
});

test("the demo's swap assets are marked as demo assets", () => {
  expect(SWAP_ASSETS.map((a) => a.code)).toEqual(["DEMOUSD", "DEMOEUR"]);
  for (const { code } of SWAP_ASSETS) expect(code.startsWith("DEMO")).toBe(true);
});

test("no step id names a real stablecoin, except the purchase of Circle's own USDC", () => {
  for (const id of MESS_STEP_IDS) {
    const named = REAL_STABLECOIN_CODES.filter((code) => id.split("_").includes(code));
    expect(named.length === 0 || id.includes("_CIRCLE_USDC")).toBe(true);
  }
});
