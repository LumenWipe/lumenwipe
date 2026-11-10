import { afterEach, describe, expect, test } from "bun:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { MediatorCheckResult } from "@lumenwipe/sdk";
import {
  EXCHANGE_API_MISSING_REASON,
  EXCHANGE_CHECK_FAILED_REASON,
  EXCHANGE_NOT_ROUTED_REASON,
  FEE_ACCOUNT_MISSING_REASON,
  MEDIATOR_KEY_MISSING_REASON,
  MEDIATOR_UNAVAILABLE_REASON,
  REGISTRY_STALE_REASON,
  SWITCHED_OFF_REASON,
  exchangeUnavailableReason,
  parseDisabledScenarios,
  unavailableFrom,
  unavailableScenarios,
  withMediatorCheck,
} from "@/lib/scenario-availability";
import { EXCHANGE_STAND_IN, parseUnavailable, validateSelection } from "@/lib/scenarios";
import { expectedFeeAccount } from "@/lib/verify-feebump";
import { expectedMediator } from "@/lib/verify-mediator";

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

const FEE_ENV = "PLAYGROUND_EXPECTED_FEE_ACCOUNT_TESTNET";
const MEDIATOR_ENV = "PLAYGROUND_EXPECTED_MEDIATOR_TESTNET";
const NO_API = { LUMENWIPE_API_URL: undefined, LUMENWIPE_API_KEY: undefined };
/** A configured mediator key, so the fee tests see only the fee account's effect. */
const mediatorKey = Keypair.random().publicKey();

/** Runs `fn` with the variables set as given, restoring them after. */
async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): Promise<void> {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    apply(env);
    await fn();
  } finally {
    apply(previous);
  }
}

test("the reason is plain language, and the list is read from the environment on each call", async () => {
  expect(SWITCHED_OFF_REASON).toBe("Switched off on this deployment for now.");
  const feeAccount = Keypair.random().publicKey();
  const base = { ...NO_API, [FEE_ENV]: feeAccount, [MEDIATOR_ENV]: mediatorKey };
  await withEnv({ ...base, PLAYGROUND_DISABLED_SCENARIOS: "data-entries" }, async () => {
    expect([...(await unavailableScenarios()).keys()]).toEqual(["data-entries", "exchange-close"]);
  });
  await withEnv({ ...base, PLAYGROUND_DISABLED_SCENARIOS: "exchange-close" }, async () => {
    expect([...(await unavailableScenarios())]).toEqual([["exchange-close", SWITCHED_OFF_REASON]]);
  });
});

test("the sponsored fee is unavailable, with its reason, without a valid fee account address", async () => {
  const unset = { disabled: undefined, feeAccount: undefined, mediatorKey };
  expect([...unavailableFrom(unset)]).toEqual([["fee-bump", FEE_ACCOUNT_MISSING_REASON]]);
  expect(FEE_ACCOUNT_MISSING_REASON).toContain("fee account");
  // A secret, a contract, a muxed account, a typo and blank text are no account address.
  const kp = Keypair.random();
  const invalid = [
    "",
    "   ",
    kp.secret(),
    StrKey.encodeContract(Buffer.alloc(32, 1)),
    StrKey.encodeMed25519PublicKey(Buffer.concat([kp.rawPublicKey(), Buffer.alloc(8)])),
    kp.publicKey().slice(0, -1),
  ];
  for (const feeAccount of invalid) {
    expect(unavailableFrom({ disabled: undefined, feeAccount, mediatorKey }).get("fee-bump")).toBe(
      FEE_ACCOUNT_MISSING_REASON
    );
  }
  expect(
    unavailableFrom({ disabled: undefined, feeAccount: kp.publicKey(), mediatorKey }).size
  ).toBe(0);
  // Switched off on purpose, it keeps that reason.
  expect(
    unavailableFrom({ disabled: "fee-bump", feeAccount: undefined, mediatorKey }).get("fee-bump")
  ).toBe(SWITCHED_OFF_REASON);
  await withEnv(
    { ...NO_API, PLAYGROUND_DISABLED_SCENARIOS: undefined, [FEE_ENV]: undefined },
    async () => {
      expect((await unavailableScenarios()).get("fee-bump")).toBe(FEE_ACCOUNT_MISSING_REASON);
      expect(expectedFeeAccount()).toBeNull();
    }
  );
  await withEnv({ [FEE_ENV]: ` ${kp.publicKey()} ` }, () => {
    expect(expectedFeeAccount()).toBe(kp.publicKey());
  });
});

test("a session asking for the unavailable sponsored fee is refused with its reason", () => {
  const unavailable = unavailableFrom({ disabled: undefined, feeAccount: undefined, mediatorKey });
  const result = validateSelection(
    {
      scenarios: [
        { id: "data-entries", params: {} },
        { id: "fee-bump", params: {} },
      ],
    },
    { unavailable }
  );
  expect(result).toEqual({
    ok: false,
    message: `Sponsored fee is not available here: ${FEE_ACCOUNT_MISSING_REASON}`,
  });
});

describe("the exchange close", () => {
  /** The API's answer for the stand-in when it can run an exchange close. */
  const READY: MediatorCheckResult = {
    requiresMediator: true,
    reason: "LumenWipe testnet exchange does not support direct account merges.",
    requiresMemo: true,
    memoType: "id",
    exchangeName: EXCHANGE_STAND_IN.name,
    available: true,
    registryFresh: true,
  };
  const configured = { disabled: undefined, feeAccount: Keypair.random().publicKey(), mediatorKey };

  test("is unavailable, with its reason, without a valid mediator key", () => {
    const kp = Keypair.random();
    for (const key of [undefined, "", kp.secret(), StrKey.encodeContract(Buffer.alloc(32, 2))]) {
      expect([...unavailableFrom({ ...configured, mediatorKey: key })]).toEqual([
        ["exchange-close", MEDIATOR_KEY_MISSING_REASON],
      ]);
    }
    expect(unavailableFrom(configured).size).toBe(0);
  });

  test("runs only when the API routes the stand-in through its relay, can co-sign and holds a fresh registry", () => {
    expect(exchangeUnavailableReason(READY)).toBeNull();
    expect(exchangeUnavailableReason(null)).toBe(EXCHANGE_CHECK_FAILED_REASON);
    expect(exchangeUnavailableReason({ ...READY, available: false })).toBe(
      MEDIATOR_UNAVAILABLE_REASON
    );
    expect(exchangeUnavailableReason({ ...READY, registryFresh: false })).toBe(
      REGISTRY_STALE_REASON
    );
    for (const off of [
      { requiresMediator: false },
      { requiresMemo: false },
      { memoType: "text" as const },
      { memoType: null },
    ]) {
      expect(exchangeUnavailableReason({ ...READY, ...off })).toBe(EXCHANGE_NOT_ROUTED_REASON);
    }
  });

  test("follows the API's mediator check, and is hidden when the check fails or says no", async () => {
    expect((await withMediatorCheck(new Map(), async () => READY)).size).toBe(0);
    const hidden = async (check: () => Promise<MediatorCheckResult>) =>
      (await withMediatorCheck(new Map(), check)).get("exchange-close");
    expect(await hidden(async () => ({ ...READY, available: false }))).toBe(
      MEDIATOR_UNAVAILABLE_REASON
    );
    expect(await hidden(async () => ({ ...READY, registryFresh: false }))).toBe(
      REGISTRY_STALE_REASON
    );
    expect(
      await hidden(async () => {
        throw new Error("down");
      })
    ).toBe(EXCHANGE_CHECK_FAILED_REASON);
    // Already ruled out by configuration: the API is not asked.
    let asked = 0;
    const off = new Map([["exchange-close" as const, SWITCHED_OFF_REASON]]);
    const kept = await withMediatorCheck(off, async () => {
      asked++;
      return READY;
    });
    expect(kept.get("exchange-close")).toBe(SWITCHED_OFF_REASON);
    expect(asked).toBe(0);
  });

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("asks the configured API about the bundled stand-in on testnet", async () => {
    const asked: string[] = [];
    const answer = (body: MediatorCheckResult) =>
      (async (input: string | URL | Request) => {
        asked.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
    const env = {
      LUMENWIPE_API_URL: "http://localhost:3001",
      LUMENWIPE_API_KEY: "playground-test",
      PLAYGROUND_DISABLED_SCENARIOS: undefined,
      [FEE_ENV]: Keypair.random().publicKey(),
      [MEDIATOR_ENV]: mediatorKey,
    };
    await withEnv(env, async () => {
      globalThis.fetch = answer(READY);
      expect((await unavailableScenarios()).size).toBe(0);
      globalThis.fetch = answer({ ...READY, available: false });
      expect((await unavailableScenarios()).get("exchange-close")).toBe(
        MEDIATOR_UNAVAILABLE_REASON
      );
      expect(expectedMediator()).toBe(mediatorKey);
    });
    expect(asked).toEqual([
      `http://localhost:3001/v1/testnet/mediator/check/${EXCHANGE_STAND_IN.address}`,
      `http://localhost:3001/v1/testnet/mediator/check/${EXCHANGE_STAND_IN.address}`,
    ]);
    await withEnv({ ...env, ...NO_API }, async () => {
      expect((await unavailableScenarios()).get("exchange-close")).toBe(
        EXCHANGE_API_MISSING_REASON
      );
    });
  });

  test("a session asking for it while it is unavailable is refused with its reason", () => {
    const unavailable = unavailableFrom({ ...configured, mediatorKey: undefined });
    expect(
      validateSelection({ scenarios: [{ id: "exchange-close", params: {} }] }, { unavailable })
    ).toEqual({
      ok: false,
      message: `Exchange deposit is not available here: ${MEDIATOR_KEY_MISSING_REASON}`,
    });
  });
});
