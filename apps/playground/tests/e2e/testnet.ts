// Public testnet endpoints the e2e suite funds and reads accounts through. Testnet only: nothing
// in this suite ever touches mainnet.

import { PINNED_ASSETS } from "../../lib/scenarios";

export const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Funds `publicKey` through Friendbot and waits until Horizon has indexed the account. */
export async function fundTestnetAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Friendbot refused a funding request (HTTP ${res.status})`);
  for (let attempt = 0; attempt < 10; attempt++) {
    if ((await fetch(`${HORIZON}/accounts/${publicKey}`)).ok) return;
    await sleep(1_500);
  }
  throw new Error("A Friendbot-funded account was not indexed by Horizon in time");
}

/** Whether the testnet DEX sells a scenario's Circle USDC within its XLM ceiling right now. */
export async function dexSellsUsdc(seed: { usdc: string; buyMaxXlm: string }): Promise<boolean> {
  const circle = PINNED_ASSETS["circle-usdc"];
  const query = new URLSearchParams({
    source_assets: "native",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: circle.code,
    destination_asset_issuer: circle.issuer,
    destination_amount: seed.usdc,
  });
  const res = await fetch(`${HORIZON}/paths/strict-receive?${query.toString()}`);
  if (!res.ok) return false;
  const body = (await res.json()) as { _embedded: { records: { source_amount: string }[] } };
  return body._embedded.records.some((r) => Number(r.source_amount) <= Number(seed.buyMaxXlm));
}
