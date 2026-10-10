import { afterEach, expect, setSystemTime, test } from "bun:test";
import { MediatorController } from "@/mediator/mediator.controller";
import { servedRegistry } from "@/lib/exchange-registry";

const exchange = servedRegistry().entries[0]!.address;

afterEach(() => {
  setSystemTime();
});

test("check reports the registry as fresh while it is inside its window", async () => {
  const result = await new MediatorController().check("testnet", exchange);
  expect(result.registryFresh).toBe(true);
  expect(result.requiresMediator).toBe(true);
});

test("check flags a stale registry before the client reaches a refusal", async () => {
  const until = servedRegistry().validUntil;
  setSystemTime(new Date(Date.parse(`${until}T23:59:59Z`) + 86_400_000));
  const result = await new MediatorController().check("testnet", exchange);
  expect(result.registryFresh).toBe(false);
});
