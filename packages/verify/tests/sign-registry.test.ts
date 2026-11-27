import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import {
  parseSignature,
  verifyRegistrySignature,
  type RegistrySignature,
} from "../../../apps/web/lib/exchange-registry/signature";
import { REGISTRY_SIGNING_KEYS } from "../../../apps/web/lib/exchange-registry/trust-roots";
import { exchangeEntry, registryBody } from "../../../apps/web/tests/unit/fixtures/signed-registry";
import { checkRegistrySignature, signRegistry } from "../scripts/sign-registry";

const SCRIPT = fileURLToPath(new URL("../scripts/sign-registry.ts", import.meta.url));
const SIGNER = Keypair.random();
const KEYS = [SIGNER.publicKey()];
const TODAY = "2026-11-27";

const registryText = (over: Partial<Parameters<typeof registryBody>[1]> = {}) =>
  JSON.stringify(registryBody([exchangeEntry(Keypair.random().publicKey())], over));

function sign(text: string, previous: RegistrySignature | null = null, signer = SIGNER) {
  return signRegistry({
    registryText: text,
    previous,
    secret: signer.secret(),
    today: TODAY,
    keys: KEYS,
  });
}

describe("signRegistry", () => {
  test("signs a registry so that the verifier accepts it", () => {
    const text = registryText();
    const envelope = sign(text);
    expect(
      verifyRegistrySignature(JSON.parse(text), envelope, {
        keys: KEYS,
        bundledSequence: 1,
        now: new Date(`${TODAY}T12:00:00Z`),
      })
    ).toEqual({ ok: true, sequence: 1 });
  });

  test("starts at sequence 1 and rises by one over the committed signature", () => {
    const text = registryText();
    expect(sign(text).sequence).toBe(1);
    const previous = sign(text);
    expect(sign(text, { ...previous, sequence: 41 }).sequence).toBe(42);
  });

  test("stamps today's date and writes only the four envelope fields", () => {
    const envelope = sign(registryText());
    expect(Object.keys(envelope).sort()).toEqual(["format", "issuedAt", "sequence", "signature"]);
    expect(envelope.issuedAt).toBe(TODAY);
    expect(parseSignature(envelope)).toEqual(envelope);
  });

  test("accepts the seed with a trailing newline", () => {
    const text = registryText();
    const envelope = signRegistry({
      registryText: text,
      previous: null,
      secret: `${SIGNER.secret()}\n`,
      today: TODAY,
      keys: KEYS,
    });
    expect(envelope.sequence).toBe(1);
  });

  test("refuses input that is not a secret seed, without echoing it", () => {
    for (const secret of ["hello", SIGNER.publicKey(), "", "S".repeat(56)]) {
      let message = "";
      try {
        signRegistry({
          registryText: registryText(),
          previous: null,
          secret,
          today: TODAY,
          keys: KEYS,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("not a Stellar secret seed");
      if (secret.length > 0) expect(message).not.toContain(secret);
    }
  });

  test("refuses a key that is not pinned, naming only its public half", () => {
    const stranger = Keypair.random();
    let message = "";
    try {
      sign(registryText(), null, stranger);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(stranger.publicKey());
    expect(message).toContain("not one of the pinned");
    expect(message).not.toContain(stranger.secret());
  });

  test("refuses a registry that has already expired", () => {
    expect(() => sign(registryText({ validUntil: "2026-11-01" }))).toThrow("expired");
  });

  test("refuses a registry it cannot write canonically or that is not JSON", () => {
    expect(() => sign("{not json")).toThrow("not valid JSON");
    expect(() => sign(JSON.stringify({ ...JSON.parse(registryText()), source: null }))).toThrow(
      "canonical"
    );
  });
});

describe("checkRegistrySignature", () => {
  const text = registryText();
  const envelope = sign(text);
  const envelopeText = JSON.stringify(envelope);
  const check = (over: Partial<Parameters<typeof checkRegistrySignature>[0]> = {}) =>
    checkRegistrySignature({
      registryText: text,
      signatureText: envelopeText,
      base: null,
      keys: KEYS,
      ...over,
    });

  test("passes a current signature", () => {
    expect(check()).toEqual([]);
  });

  test("fails with no signature file", () => {
    expect(check({ signatureText: null })[0]).toContain("does not exist");
  });

  test("fails a registry changed after it was signed", () => {
    const changed = JSON.stringify({ ...JSON.parse(text), lastVerified: "2026-11-26" });
    expect(check({ registryText: changed })[0]).toContain("does not verify");
  });

  test("fails a signature by a key that is not pinned", () => {
    expect(check({ keys: [Keypair.random().publicKey()] })[0]).toContain("does not verify");
  });

  test("fails a malformed envelope and one that is not JSON", () => {
    expect(check({ signatureText: JSON.stringify({ ...envelope, extra: 1 }) })[0]).toContain(
      "not a version 1"
    );
    expect(check({ signatureText: "{" })[0]).toContain("not valid JSON");
  });

  test("the pinned keys are used when none are passed", () => {
    expect(
      checkRegistrySignature({ registryText: text, signatureText: envelopeText, base: null })[0]
    ).toContain("does not verify");
    expect(REGISTRY_SIGNING_KEYS.length).toBe(2);
  });

  describe("against the base branch", () => {
    const base = (seq: number, registry = text) => ({
      registryText: registry,
      signatureText: JSON.stringify({ ...envelope, sequence: seq }),
    });
    const headAt = (seq: number, registry = text) => {
      const e = signRegistry({
        registryText: registry,
        previous: { ...envelope, sequence: seq - 1 },
        secret: SIGNER.secret(),
        today: TODAY,
        keys: KEYS,
      });
      return { registryText: registry, signatureText: JSON.stringify(e) };
    };
    const edited = JSON.stringify({ ...JSON.parse(text), lastVerified: "2026-11-20" });

    test("an unchanged registry at the same sequence passes", () => {
      expect(check({ base: base(1) })).toEqual([]);
    });

    test("an unchanged registry at a lower sequence fails", () => {
      expect(check({ ...headAt(2, text), base: base(5) })[0]).toContain("fell from 5 to 2");
    });

    test("a changed registry at the same sequence fails", () => {
      expect(check({ ...headAt(5, edited), base: base(5) })[0]).toContain("not above 5");
    });

    test("a changed registry at a lower sequence fails", () => {
      expect(check({ ...headAt(3, edited), base: base(5) })[0]).toContain("not above 5");
    });

    test("a changed registry at a higher sequence passes", () => {
      expect(check({ ...headAt(6, edited), base: base(5) })).toEqual([]);
    });

    test("a base with no signature counts as sequence 0, and no base registry as changed", () => {
      expect(check({ base: { registryText: text, signatureText: null } })).toEqual([]);
      expect(check({ base: { registryText: null, signatureText: null } })).toEqual([]);
    });
  });
});

describe("the command", () => {
  const run = (args: string[], stdin: string) =>
    spawnSync("bun", [SCRIPT, ...args], { input: stdin, encoding: "utf8" });

  test("a seed given as an argument is refused and never echoed", () => {
    const seed = Keypair.random().secret();
    const result = run([seed], "");
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(seed);
  });

  test("a seed on stdin that is not pinned is refused and never echoed", () => {
    const seed = Keypair.random().secret();
    const result = run([], `${seed}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not one of the pinned");
    expect(result.stdout + result.stderr).not.toContain(seed);
  });

  test("garbage on stdin is refused and never echoed", () => {
    const result = run([], "SUPERSECRETLOOKINGTEXT\n");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("SUPERSECRETLOOKINGTEXT");
  });

  test("--check takes no seed, and --base needs a revision", () => {
    expect(run(["--check", "extra"], "").status).toBe(2);
    expect(run(["--check", "--base"], "").status).toBe(2);
  });

  test("--check against an unavailable base fails instead of passing", () => {
    const result = run(["--check", "--base", "no-such-revision-anywhere"], "");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not available");
  });
});
