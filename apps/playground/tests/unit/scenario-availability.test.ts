import { expect, test } from "bun:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  FEE_ACCOUNT_MISSING_REASON,
  SWITCHED_OFF_REASON,
  parseDisabledScenarios,
  unavailableFrom,
  unavailableScenarios,
} from "@/lib/scenario-availability";
import { parseUnavailable, validateSelection } from "@/lib/scenarios";
import { expectedFeeAccount } from "@/lib/verify-feebump";

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

/** Runs `fn` with the two variables set as given, restoring them after. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    apply(env);
    fn();
  } finally {
    apply(previous);
  }
}

test("the reason is plain language, and the list is read from the environment on each call", () => {
  expect(SWITCHED_OFF_REASON).toBe("Switched off on this deployment for now.");
  const feeAccount = Keypair.random().publicKey();
  withEnv({ PLAYGROUND_DISABLED_SCENARIOS: "data-entries", [FEE_ENV]: feeAccount }, () => {
    expect([...unavailableScenarios().keys()]).toEqual(["data-entries"]);
  });
  withEnv({ PLAYGROUND_DISABLED_SCENARIOS: undefined, [FEE_ENV]: feeAccount }, () => {
    expect(unavailableScenarios().size).toBe(0);
  });
});

test("the sponsored fee is unavailable, with its reason, without a valid fee account address", () => {
  const unset = { disabled: undefined, feeAccount: undefined };
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
    expect(unavailableFrom({ disabled: undefined, feeAccount }).get("fee-bump")).toBe(
      FEE_ACCOUNT_MISSING_REASON
    );
  }
  expect(unavailableFrom({ disabled: undefined, feeAccount: kp.publicKey() }).size).toBe(0);
  // Switched off on purpose, it keeps that reason.
  expect(unavailableFrom({ disabled: "fee-bump", feeAccount: undefined }).get("fee-bump")).toBe(
    SWITCHED_OFF_REASON
  );
  withEnv({ PLAYGROUND_DISABLED_SCENARIOS: undefined, [FEE_ENV]: undefined }, () => {
    expect(unavailableScenarios().get("fee-bump")).toBe(FEE_ACCOUNT_MISSING_REASON);
    expect(expectedFeeAccount()).toBeNull();
  });
  withEnv({ [FEE_ENV]: ` ${kp.publicKey()} ` }, () => {
    expect(expectedFeeAccount()).toBe(kp.publicKey());
  });
});

test("a session asking for the unavailable sponsored fee is refused with its reason", () => {
  const unavailable = unavailableFrom({ disabled: undefined, feeAccount: undefined });
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
