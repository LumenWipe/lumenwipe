// Public testnet endpoints the e2e suite funds and reads accounts through. Testnet only: nothing
// in this suite ever touches mainnet.

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
