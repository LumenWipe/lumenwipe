import { expect, test } from "bun:test";
import { STATUS } from "@/lib/i18n/messages/status";
import {
  HOSTED_COMPONENT_NAMES,
  isHostedStatusPage,
  parseHostedStatusPage,
} from "@/lib/status/hosted-page";
import { RPC_DEGRADED } from "./fixtures/status/summaries";
import {
  HOSTED_ALL_OPERATIONAL,
  HOSTED_MALFORMED,
  HOSTED_MIXED,
  hostedPage,
} from "./fixtures/status/hosted-pages";

test("hosted status page › the names the page is read by are the banner's English labels", () => {
  expect<Record<string, string>>(HOSTED_COMPONENT_NAMES).toEqual(STATUS.en.components);
  expect<Record<string, string>>(HOSTED_COMPONENT_NAMES).toEqual({
    api: "API",
    web: "Web app",
    "user-path": "Account analysis and planning",
    "rpc-testnet": "Stellar RPC (testnet)",
    "rpc-mainnet": "Stellar RPC (mainnet)",
    "horizon-testnet": "Horizon (testnet)",
    "horizon-mainnet": "Horizon (mainnet)",
    indexer: "Indexer",
  });
});

test("hosted status page › the live page's rows map to their components, without docs or playground", () => {
  expect(parseHostedStatusPage(HOSTED_ALL_OPERATIONAL)).toEqual({
    components: [
      { id: "api", state: "operational" },
      { id: "web", state: "operational" },
      { id: "rpc-mainnet", state: "operational" },
      { id: "rpc-testnet", state: "operational" },
      { id: "horizon-mainnet", state: "operational" },
      { id: "horizon-testnet", state: "operational" },
    ],
  });
});

test("hosted status page › each status maps to a state, and nothing else leaves the page", () => {
  expect(parseHostedStatusPage(HOSTED_MIXED)).toEqual({
    components: [
      { id: "api", state: "operational" },
      { id: "web", state: "degraded" },
      { id: "user-path", state: "outage" },
      { id: "rpc-mainnet", state: "degraded" },
      { id: "indexer", state: "operational" },
    ],
  });
});

test.each([
  ["operational", "operational"],
  ["degraded", "degraded"],
  ["maintenance", "degraded"],
  ["downtime", "outage"],
])("hosted status page › %s is shown as %s", (status, state) => {
  expect(parseHostedStatusPage(hostedPage([{ name: "Indexer", status }])) as unknown).toEqual({
    components: [{ id: "indexer", state }],
  });
});

test("hosted status page › a row that is not monitored is left out", () => {
  expect(parseHostedStatusPage(hostedPage([{ name: "API", status: "not_monitored" }]))).toEqual({
    components: [],
  });
});

test.each([
  ["__proto__"],
  ["constructor"],
  ["toString"],
  ["api"],
  ["api "],
  [null],
  [7],
  [["API"]],
])("hosted status page › a row named %p is skipped, whatever its status", (name) => {
  const page = hostedPage([
    { name, status: "downtime" },
    { name, status: "paused" },
    { name: "API", status: "degraded" },
  ]);
  expect(parseHostedStatusPage(page)).toEqual({ components: [{ id: "api", state: "degraded" }] });
});

test.each(HOSTED_MALFORMED)("hosted status page › %s is not a summary", (_, body) => {
  expect(isHostedStatusPage(body)).toBe(true);
  expect(parseHostedStatusPage(body)).toBeNull();
});

test.each([
  ["the summary shape", RPC_DEGRADED],
  ["another JSON:API type", { data: { type: "status_report" }, included: [] }],
  ["a data list", { data: [{ type: "status_page" }], included: [] }],
  ["null", null],
])("hosted status page › %s is not a status page", (_, body) => {
  expect(isHostedStatusPage(body)).toBe(false);
  expect(parseHostedStatusPage(body)).toBeNull();
});
