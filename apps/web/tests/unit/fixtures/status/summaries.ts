/** Status host bodies the contract is tested against. */

export const ALL_OPERATIONAL = {
  components: [
    { id: "api", state: "operational" },
    { id: "web", state: "operational" },
    { id: "rpc-mainnet", state: "operational" },
  ],
};

export const RPC_DEGRADED = {
  components: [
    { id: "api", state: "operational" },
    { id: "rpc-mainnet", state: "degraded" },
    { id: "horizon-testnet", state: "outage" },
  ],
};

/** Components the close flow never calls, and fields the banner must never show. */
export const WITH_EXTRAS = {
  updatedAt: "2026-11-20T00:00:00Z",
  components: [
    { id: "docs", state: "outage", name: "Docs" },
    { id: "playground", state: "degraded" },
    {
      id: "api",
      state: "degraded",
      uptime: "99.98",
      name: "Totally the API",
      url: "https://x.test",
    },
  ],
};

export const MALFORMED = [
  null,
  "operational",
  [],
  {},
  { components: "api" },
  { components: [null] },
  { components: [{ id: "api", state: "down" }] },
  { components: [{ id: "api" }] },
  {
    components: [
      { id: "api", state: "operational" },
      { id: "api", state: "outage" },
    ],
  },
];
