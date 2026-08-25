import { test, expect } from "bun:test";
import {
  getMessPlanForMode,
  getNeededEphemeralCodes,
  maxOfferCount,
  isMessStepId,
} from "@/lib/mess-plan";

test("light mode is the shortest plan", () => {
  const plan = getMessPlanForMode("light");
  expect(plan.map((s) => s.id)).toEqual(["SETUP", "TRUST_LWDEMO", "FUND_LWDEMO"]);
});

test("full mode needs all four ephemeral assets", () => {
  expect(getNeededEphemeralCodes("full")).toEqual(["AIRDROP1", "RUGPULL", "USDC", "EURC"]);
});

test("custom mode respects trustlineCount for ephemeral codes", () => {
  expect(
    getNeededEphemeralCodes("custom", {
      trustlineCount: 3,
      offerCount: 0,
      dataEntryCount: 0,
      addSigner: false,
    })
  ).toEqual(["AIRDROP1", "RUGPULL"]);
});

test("maxOfferCount is capped by both trustlineCount and the junk-offer catalog", () => {
  expect(maxOfferCount(2)).toBe(2);
  expect(maxOfferCount(10)).toBe(5); // JUNK_OFFERS.length
});

test("isMessStepId recognizes known step ids and rejects unknown ones", () => {
  expect(isMessStepId("SETUP")).toBe(true);
  expect(isMessStepId("DATA_ENTRIES")).toBe(true);
  expect(isMessStepId("NOT_A_STEP")).toBe(false);
});
