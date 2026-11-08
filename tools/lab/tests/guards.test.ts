import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MAX_BALANCE_CAP_XLM,
  assertConfirmed,
  assertDestinationAllowed,
  assertUnderBalanceCap,
  confirmationPhrase,
  masterWeight,
  requireNetwork,
  resolveBalanceCap,
  toStroops,
} from "../src/guards";
import { LabRefusal } from "../src/home";

const source = Keypair.random().publicKey();
const allowed = Keypair.random().publicKey();
const other = Keypair.random().publicKey();

describe("network", () => {
  test("has no default", () => {
    expect(() => requireNetwork(undefined)).toThrow(/no default/);
    expect(() => requireNetwork("")).toThrow(/no default/);
    expect(() => requireNetwork("futurenet")).toThrow(LabRefusal);
    expect(requireNetwork("testnet")).toBe("testnet");
    expect(requireNetwork("mainnet")).toBe("mainnet");
  });
});

describe("balance cap", () => {
  test("refuses a source above the cap and accepts one at it", () => {
    expect(() => assertUnderBalanceCap("100.0000001", "100")).toThrow(/above the 100 XLM cap/);
    expect(() => assertUnderBalanceCap("5000", "100")).toThrow(LabRefusal);
    expect(() => assertUnderBalanceCap("100", "100")).not.toThrow();
    expect(() => assertUnderBalanceCap("2.5", "100")).not.toThrow();
  });

  test("refuses a balance that is not an amount", () => {
    expect(() => assertUnderBalanceCap("1e3", "100")).toThrow(LabRefusal);
    expect(() => assertUnderBalanceCap("-1", "100")).toThrow(LabRefusal);
  });

  test("can be lowered by config, never raised past the ceiling", () => {
    expect(resolveBalanceCap(undefined)).toBe(MAX_BALANCE_CAP_XLM);
    expect(resolveBalanceCap(20)).toBe("20");
    expect(resolveBalanceCap("0.5")).toBe("0.5");
    expect(() => resolveBalanceCap(100.0000001)).toThrow(/at most 100/);
    expect(() => resolveBalanceCap("1000")).toThrow(LabRefusal);
    expect(() => resolveBalanceCap(0)).toThrow(LabRefusal);
  });

  test("compares in stroops, not floats", () => {
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("100")).toBe(1_000_000_000n);
    expect(() => toStroops("1.00000001")).toThrow(LabRefusal);
  });
});

describe("destination allowlist", () => {
  test("accepts only an exact allowlisted address", () => {
    expect(assertDestinationAllowed(allowed, source, [allowed])).toBe(allowed);
    expect(() => assertDestinationAllowed(other, source, [allowed])).toThrow(/allowlist/);
    expect(() => assertDestinationAllowed(allowed.toLowerCase(), source, [allowed])).toThrow(
      LabRefusal
    );
    expect(() => assertDestinationAllowed(allowed, source, [])).toThrow(/allowlist/);
  });

  test("refuses a missing, malformed or self destination", () => {
    expect(() => assertDestinationAllowed(undefined, source, [allowed])).toThrow(/--destination/);
    expect(() => assertDestinationAllowed("GNOTANADDRESS", source, ["GNOTANADDRESS"])).toThrow(
      /not a valid/
    );
    expect(() => assertDestinationAllowed(source, source, [source])).toThrow(/source itself/);
  });
});

describe("typed confirmation", () => {
  const phrase = confirmationPhrase(source);

  test("is CLOSE and the last six characters of the source", () => {
    expect(phrase).toBe(`CLOSE ${source.slice(-6)}`);
  });

  test("refuses anything but the exact phrase", () => {
    expect(() => assertConfirmed(phrase, source, true)).not.toThrow();
    expect(() => assertConfirmed(`  ${phrase}\n`, source, true)).not.toThrow();
    for (const typed of [
      null,
      "",
      "CLOSE",
      "close " + source.slice(-6),
      "yes",
      `CLOSE ${other.slice(-6)}`,
    ]) {
      expect(() => assertConfirmed(typed, source, true)).toThrow(/did not match/);
    }
  });

  test("refuses without a terminal, even with the right phrase", () => {
    expect(() => assertConfirmed(phrase, source, false)).toThrow(/needs a terminal/);
  });
});

describe("signer shape", () => {
  const thresholds = { low: 0, med: 0, high: 0 };

  test("accepts a source signed by its own key alone", () => {
    expect(
      masterWeight({
        address: source,
        signers: [{ key: source, type: "ed25519_public_key", weight: 1 }],
        thresholds,
      })
    ).toBe(1);
  });

  test("refuses extra signers, a foreign key, or a key below the high threshold", () => {
    const own = { key: source, type: "ed25519_public_key", weight: 1 };
    expect(() =>
      masterWeight({ address: source, signers: [own, { ...own, key: other }], thresholds })
    ).toThrow(LabRefusal);
    expect(() =>
      masterWeight({ address: source, signers: [{ ...own, key: other }], thresholds })
    ).toThrow(LabRefusal);
    expect(() => masterWeight({ address: source, signers: [], thresholds })).toThrow(LabRefusal);
    expect(() =>
      masterWeight({ address: source, signers: [own], thresholds: { low: 1, med: 2, high: 2 } })
    ).toThrow(/high threshold/);
  });
});
