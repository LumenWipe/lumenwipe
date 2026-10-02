import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
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
  return keypair.sign(digest).toString("base64");
}

describe("verifyChallenge", () => {
  test("accepts a challenge signed by the address owner", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), NOW)).toBe(true);
  });

  test("rejects a signature from a different key", () => {
    const owner = Keypair.random();
    const { message } = buildChallenge(SECRET, owner.publicKey(), NOW);
    const forged = sign(Keypair.random(), message);
    expect(verifyChallenge(SECRET, owner.publicKey(), message, forged, NOW)).toBe(false);
  });

  test("rejects a signature over a different message", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, "other"), NOW)).toBe(false);
  });

  test("rejects a challenge issued for another address", () => {
    const owner = Keypair.random();
    const attacker = Keypair.random();
    const { message } = buildChallenge(SECRET, owner.publicKey(), NOW);
    expect(
      verifyChallenge(SECRET, attacker.publicKey(), message, sign(attacker, message), NOW)
    ).toBe(false);
  });

  test("rejects an expired challenge", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    const later = new Date(NOW.getTime() + 301_000);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), later)).toBe(false);
  });

  test("rejects a self-made message that was not minted by this server", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge("another-secret-0123456789-abcdef", kp.publicKey(), NOW);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, sign(kp, message), NOW)).toBe(false);
  });

  test("rejects malformed signatures", () => {
    const kp = Keypair.random();
    const { message } = buildChallenge(SECRET, kp.publicKey(), NOW);
    expect(verifyChallenge(SECRET, kp.publicKey(), message, "AAAA", NOW)).toBe(false);
    expect(verifyChallenge(SECRET, kp.publicKey(), "garbage", "AAAA", NOW)).toBe(false);
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
