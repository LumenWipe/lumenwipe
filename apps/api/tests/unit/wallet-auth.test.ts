import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  buildChallenge,
  issueSession,
  verifyChallenge,
  verifySession,
} from "@/integrator/wallet-auth";

const SECRET = "test-integrator-auth-secret-0123456789";
const NOW = new Date("2026-01-01T00:00:00Z");

function sign(keypair: Keypair, message: string): string {
  const digest = createHash("sha256").update(`Stellar Signed Message:\n${message}`).digest();
  return Buffer.from(keypair.sign(digest)).toString("base64");
}

describe("verifyChallenge", () => {
  test("accepts a challenge signed by the address owner and answers its own expiry", () => {
    const kp = Keypair.random();
    const { message, expiresAt } = buildChallenge(SECRET, kp.publicKey(), NOW);
    const later = new Date(NOW.getTime() + 120_000);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), later)).toEqual(
      new Date(expiresAt)
    );
  });

  test("no two challenges are the same, even for one address in one window", () => {
    const kp = Keypair.random();
    const first = buildChallenge(SECRET, kp.publicKey(), NOW).message;
    const second = buildChallenge(SECRET, kp.publicKey(), NOW).message;
    expect(second).not.toBe(first);
    for (const message of [first, second]) {
      expect(
        verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), NOW)
      ).not.toBeNull();
    }
  });

  test("rejects a message whose salt was edited or removed", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    const salt = /Nonce: ([^.]+)\./.exec(message)![1]!;
    const swapped = message.replace(
      salt,
      salt.startsWith("A") ? `B${salt.slice(1)}` : `A${salt.slice(1)}`
    );
    const unsalted = message.replace(`${salt}.`, "");
    for (const forged of [swapped, unsalted]) {
      expect(verifyChallenge(SECRET, kp.publicKey(), forged, sign(kp, forged), NOW)).toBeNull();
    }
  });

  test("rejects a signature from a different key", () => {
    const owner = Keypair.random();
    const { message } = buildChallenge(SECRET, owner.publicKey(), NOW);
    const forged = sign(Keypair.random(), message);
    expect(verifyChallenge(SECRET, owner.publicKey(), message, forged, NOW)).toBeNull();
  });

  test("rejects a signature over a different message", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, "other"), NOW)).toBeNull();
  });

  test("rejects a challenge issued for another address", () => {
    const owner = Keypair.random();
    const attacker = Keypair.random();
    const { message } = buildChallenge(SECRET, owner.publicKey(), NOW);
    expect(
      verifyChallenge(SECRET, attacker.publicKey(), message, sign(attacker, message), NOW)
    ).toBeNull();
  });

  test("rejects an expired challenge", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    const later = new Date(NOW.getTime() + 301_000);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), later)).toBeNull();
  });

  test("still accepts a challenge just before it expires", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    const nearEnd = new Date(NOW.getTime() + 299_000);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), nearEnd)).toEqual(
      new Date(NOW.getTime() + 300_000)
    );
  });

  test("rejects a message whose issued time was edited", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    const forged = message.replace(/Issued: \d+/, "Issued: 9999999999");
    expect(verifyChallenge(SECRET, kp.publicKey(), forged, sign(kp, forged), NOW)).toBeNull();
  });

  test("rejects a self-made message that was not minted by this server", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge("another-secret-0123456789-abcdef", kp.publicKey(), NOW);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), NOW)).toBeNull();
  });

  test("rejects malformed signatures", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, "AAAA", NOW)).toBeNull();
    expect(verifyChallenge(SECRET, kp.publicKey(), "garbage", "AAAA", NOW)).toBeNull();
  });
});

describe("sessions", () => {
  const address = Keypair.random().publicKey();

  test("round-trips an issued session", () => {
    expect(verifySession(SECRET, issueSession(SECRET, address, NOW).token, NOW)).toBe(address);
  });

  test("rejects an expired session", () => {
    const { token } = issueSession(SECRET, address, NOW);
    expect(verifySession(SECRET, token, new Date(NOW.getTime() + 1_801_000))).toBeNull();
  });

  test("rejects a session whose address was swapped", () => {
    const { token } = issueSession(SECRET, address, NOW);
    const forged = token.replace(address, Keypair.random().publicKey());
    expect(verifySession(SECRET, forged, NOW)).toBeNull();
  });

  test("rejects a session signed with another secret", () => {
    const { token } = issueSession("another-secret-0123456789-abcdef", address, NOW);
    expect(verifySession(SECRET, token, NOW)).toBeNull();
  });

  test("rejects malformed tokens", () => {
    expect(verifySession(SECRET, "lw_somethingelse", NOW)).toBeNull();
    expect(verifySession(SECRET, "lws.a.b.c.d", NOW)).toBeNull();
  });
});

describe("verifySession owners", () => {
  test("a session can name a contract account, and nothing but a G or C address", () => {
    const contract = StrKey.encodeContract(Buffer.alloc(32, 1));
    expect(verifySession(SECRET, issueSession(SECRET, contract, NOW).token, NOW)).toBe(contract);
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 2));
    expect(verifySession(SECRET, issueSession(SECRET, muxed, NOW).token, NOW)).toBeNull();
    expect(verifySession(SECRET, issueSession(SECRET, "anyone", NOW).token, NOW)).toBeNull();
  });
});
