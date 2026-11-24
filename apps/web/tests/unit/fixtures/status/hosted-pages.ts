/**
 * Hosted status page bodies, in the shape of a capture of the live page: a JSON:API document with
 * the sections and one resource per row, each with its uptime figure and daily history.
 */

interface Row {
  name: unknown;
  status: unknown;
}

let nextId = 9058531;

export function resource({ name, status }: Row): Record<string, unknown> {
  return {
    id: String(nextId++),
    type: "status_page_resource",
    attributes: {
      status_page_section_id: 366796,
      resource_id: 5293155,
      resource_type: "Monitor",
      public_name: name,
      explanation: "The service at service.example.test.",
      position: 0,
      availability: 0.9998,
      status,
      status_not_updated_since: null,
      status_history: [
        {
          day: "2026-11-23",
          status: "not_monitored",
          downtime_duration: 0,
          maintenance_duration: 0,
        },
        { day: "2026-11-24", status: "downtime", downtime_duration: 120, maintenance_duration: 0 },
      ],
    },
  };
}

export function hostedPage(rows: Row[], aggregateState = "operational"): Record<string, unknown> {
  return {
    data: {
      id: "123456",
      type: "status_page",
      attributes: {
        company_name: "Example",
        company_url: "https://www.example.test/",
        contact_url: "mailto:contact@example.test",
        logo_url: "https://cdn.example.test/logo.png",
        timezone: "UTC",
        subdomain: "example",
        custom_domain: null,
        announcement: null,
        created_at: "2026-11-24T19:23:35.144Z",
        updated_at: "2026-11-24T19:39:04.519Z",
        aggregate_state: aggregateState,
      },
      relationships: { status_reports: { data: [] } },
    },
    included: [
      { id: "366796", type: "status_page_section", attributes: { name: "LumenWipe", position: 0 } },
      {
        id: "366797",
        type: "status_page_section",
        attributes: { name: "Dependencies", position: 1 },
      },
      ...rows.map(resource),
    ],
  };
}

/** The rows of the live page, all operational. */
export const HOSTED_ALL_OPERATIONAL = hostedPage(
  [
    "API",
    "Web app",
    "Docs",
    "Playground",
    "Stellar RPC (mainnet)",
    "Stellar RPC (testnet)",
    "Horizon (mainnet)",
    "Horizon (testnet)",
  ].map((name) => ({ name, status: "operational" }))
);

/** One row per status the page documents, and rows the close flow never calls. */
export const HOSTED_MIXED = hostedPage(
  [
    { name: "API", status: "operational" },
    { name: "Web app", status: "degraded" },
    { name: "Docs", status: "downtime" },
    { name: "Playground", status: "a status nobody documented" },
    { name: "Account analysis and planning", status: "downtime" },
    { name: "Stellar RPC (mainnet)", status: "maintenance" },
    { name: "Stellar RPC (testnet)", status: "not_monitored" },
    { name: "Indexer", status: "operational" },
  ],
  "downtime"
);

const api = { name: "API", status: "operational" };

export const HOSTED_MALFORMED: [string, unknown][] = [
  ["no included list", { data: { type: "status_page" } }],
  ["an included list that is not a list", { data: { type: "status_page" }, included: {} }],
  ["an entry that is not an object", { data: { type: "status_page" }, included: [null] }],
  [
    "a resource without attributes",
    { data: { type: "status_page" }, included: [{ type: "status_page_resource" }] },
  ],
  ["an unknown status on a listed row", hostedPage([{ name: "API", status: "paused" }])],
  ["a missing status on a listed row", hostedPage([{ name: "API", status: undefined }])],
  ["a status that is not a string", hostedPage([{ name: "API", status: ["downtime"] }])],
  ["a prototype key as a status", hostedPage([{ name: "API", status: "constructor" }])],
  ["a listed row twice", hostedPage([api, { name: "API", status: "downtime" }])],
  [
    "a listed row twice, once unmonitored",
    hostedPage([{ name: "API", status: "not_monitored" }, api]),
  ],
];
