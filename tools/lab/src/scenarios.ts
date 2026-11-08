export type Network = "testnet" | "mainnet";

export const NETWORKS: readonly Network[] = ["testnet", "mainnet"];

/** Public accounts of a known shape, read only. A testnet reset can remove one: the run then
 *  reports that scenario as missing instead of failing. Shapes checked on Horizon 2026-11-09. */
export const FIXTURES = {
  mainnet: {
    // No sub-entries, no positions; a long-lived public account.
    baseline: "GCCD6AJOYZCUAQLX32ZJF2MKFFAUJ53PVCFQI3RHWKL3V47QYE2BNAUT",
    // 233 sub-entries, mostly open offers.
    dense: "GC73X2MBYOGHPGAYPQS62ZFCHNOP5XAIV2DW4W62CBXFIILXJUEQLX5X",
    // Holds a Soroban token outside the curated lists.
    token: "GBZVDYLAYVGQW6GVBUXROVXZO3AQXC6ZQRJYCNHVXU7NG26BJTHKFSIK",
    // A Blend supply position and no sub-entries.
    defi: "GBXIT5W7J7BWYPAZUPFV3RHDVGD5EKIIHKTSYOL5GSADD3YGMIHPLNQX",
    pathAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  testnet: {
    baseline: "GAXJNOAUVBZMQG5RFULTTIXG4JUHTFU4BM7DQYANR2CGLP24AUMKYYZU",
    // 375 sub-entries, mostly open offers.
    dense: "GDUFELVZEZ3CX5PLYJAGPZ7CIM3HTVAD2JRHKXTGK4N5B2ADCALW7NGW",
    token: "GDGHXOVHOT5PWDAR3GZWZ6KUD2ZBFYCDWWJBUMMC4BEWGB3RD254NRKR",
    defi: undefined,
    pathAsset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
} as const satisfies Record<
  Network,
  {
    baseline: string;
    dense: string;
    token: string;
    defi: string | undefined;
    pathAsset: string;
  }
>;

export interface Scenario {
  id: string;
  network: Network;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  /** The account the request reads, when it names one: a 404 there means the fixture is gone. */
  fixture?: string;
  what: string;
}

const DESTINATION_ACK = "i_control_this_address";

export function scenariosFor(network: Network): Scenario[] {
  const f = FIXTURES[network];
  const base = `/v1/${network}`;
  const closeBody = {
    source: f.baseline,
    destination: f.token,
    decisions: [{ id: `destination:${f.token}`, choice: DESTINATION_ACK }],
  };
  const scenarios: Scenario[] = [
    {
      id: "health",
      network,
      method: "GET",
      path: "/health",
      what: "No upstream: the process alone",
    },
    {
      id: "analyze-baseline",
      network,
      method: "GET",
      path: `${base}/account/${f.baseline}`,
      fixture: f.baseline,
      what: "Analysis of an account with no sub-entries",
    },
    {
      id: "analyze-dense",
      network,
      method: "GET",
      path: `${base}/account/${f.dense}`,
      fixture: f.dense,
      what: "Analysis of an account with hundreds of sub-entries (Horizon enumeration)",
    },
    {
      id: "analyze-token",
      network,
      method: "GET",
      path: `${base}/account/${f.token}`,
      fixture: f.token,
      what: "Analysis of an account holding a Soroban token outside the curated lists (event scan)",
    },
  ];
  if (f.defi) {
    scenarios.push({
      id: "analyze-defi",
      network,
      method: "GET",
      path: `${base}/account/${f.defi}`,
      fixture: f.defi,
      what: "Analysis of an account with a DeFi position (position indexer or ledger fallback)",
    });
  }
  scenarios.push(
    {
      id: "allowances",
      network,
      method: "GET",
      path: `${base}/allowances/${f.token}`,
      fixture: f.token,
      what: "Allowance discovery",
    },
    {
      id: "paths",
      network,
      method: "GET",
      path: `${base}/paths?fromAsset=${encodeURIComponent(f.pathAsset)}&amount=10`,
      what: "Conversion path lookup",
    },
    {
      id: "plan",
      network,
      method: "POST",
      path: `${base}/close/plan`,
      body: closeBody,
      fixture: f.baseline,
      what: "Plan build",
    },
    {
      id: "transactions",
      network,
      method: "POST",
      path: `${base}/close/transactions`,
      body: closeBody,
      fixture: f.baseline,
      what: "Unsigned transaction build (nothing is signed or submitted)",
    }
  );
  return scenarios;
}

export function allScenarios(networks: readonly Network[]): Scenario[] {
  return networks.flatMap(scenariosFor);
}
