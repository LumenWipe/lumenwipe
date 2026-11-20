import { expect, test } from "bun:test";
import { affectedComponents, parseStatusSummary } from "@/lib/status/summary";
import { ALL_OPERATIONAL, MALFORMED, RPC_DEGRADED, WITH_EXTRAS } from "./fixtures/status/summaries";

test("status summary › a summary keeps each listed component and its state", () => {
  expect(parseStatusSummary(RPC_DEGRADED) as unknown).toEqual(RPC_DEGRADED);
});

test("status summary › components the close flow does not call and extra fields are dropped", () => {
  expect(parseStatusSummary(WITH_EXTRAS)).toEqual({
    components: [{ id: "api", state: "degraded" }],
  });
});

test.each(MALFORMED.map((body) => [JSON.stringify(body), body]))(
  "status summary › %s is not a summary",
  (_, body) => {
    expect(parseStatusSummary(body)).toBeNull();
  }
);

test("status summary › only components that are not operational are affected", () => {
  expect(affectedComponents(parseStatusSummary(ALL_OPERATIONAL)!)).toEqual([]);
  expect(affectedComponents(parseStatusSummary(RPC_DEGRADED)!)).toEqual([
    { id: "rpc-mainnet", state: "degraded" },
    { id: "horizon-testnet", state: "outage" },
  ]);
});
