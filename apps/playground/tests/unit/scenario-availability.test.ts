import { expect, test } from "bun:test";
import { SWITCHED_OFF_REASON, parseDisabledScenarios } from "@/lib/scenario-availability";
import { parseUnavailable } from "@/lib/scenarios";

test("PLAYGROUND_DISABLED_SCENARIOS switches off the listed scenarios", () => {
  expect([...parseDisabledScenarios(" stale-offers ,forgotten-signer")]).toEqual([
    ["stale-offers", SWITCHED_OFF_REASON],
    ["forgotten-signer", SWITCHED_OFF_REASON],
  ]);
});

test("unset, empty, unknown and repeated entries switch off nothing extra", () => {
  expect(parseDisabledScenarios(undefined).size).toBe(0);
  expect(parseDisabledScenarios("").size).toBe(0);
  expect(parseDisabledScenarios(" , ,").size).toBe(0);
  expect(parseDisabledScenarios("toString,STALE-OFFERS,stale offers").size).toBe(0);
  expect([...parseDisabledScenarios("data-entries,data-entries").keys()]).toEqual(["data-entries"]);
});

test("the client reads the route's list and skips anything malformed", () => {
  const body = {
    unavailable: [
      { id: "stale-offers", reason: "Switched off." },
      { id: "no-such-scenario", reason: "x" },
      { id: "data-entries", reason: 7 },
      "forgotten-signer",
      null,
    ],
  };
  expect([...parseUnavailable(body)]).toEqual([["stale-offers", "Switched off."]]);
  for (const bad of [null, "x", [], {}, { unavailable: "all" }]) {
    expect(parseUnavailable(bad).size).toBe(0);
  }
});
