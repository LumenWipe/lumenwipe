import type { ScenarioSelection } from "./types";

// The exchange an exchange-close session deposits into: the testnet-only stand-in the bundled
// exchange registry lists (apps/api/src/config/exchange-registry.json, "network": "testnet"). It is
// restated here rather than read from configuration, so no deployment setting can point a close at
// another address; tests/unit/exchange-close.test.ts pins it to the registry bundled in
// @lumenwipe/verify, and the API recipe fixture pins it to the API's copy.
//
// Only the stand-in's public key was ever recorded, so nobody can sign for it. The playground's
// market maker creates the account on testnet when it is missing (after a testnet reset), and
// what a close forwards to it stays there.
//
// Isomorphic like the rest of lib/scenarios: plain strings, no Stellar SDK.

export const EXCHANGE_STAND_IN = {
  address: "GB4VXLVR2DDIJUPVVY74QVPEIHINBMMXO6WUY67JUEYO42LQSDS5IMKW",
  name: "LumenWipe testnet exchange",
  /** The registry's memo type for it: a deposit is credited by an id memo only. */
  memoType: "id",
} as const;

/** What the market maker creates the stand-in with when it is missing: its two base reserves. */
export const EXCHANGE_STAND_IN_FUNDING_XLM = "1";

/** Whether a selection closes into the exchange stand-in rather than the market maker. */
export function closesToExchange(selection: ScenarioSelection): boolean {
  return selection.scenarios.some((c) => c.id === "exchange-close");
}
