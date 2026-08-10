import { test, expect } from "bun:test";
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { revokeSponsorshipOps } from "@/lib/stellar/tx-builder/sponsorship";
import type { SponsoredEntry } from "@lumenwipe/types";

const OWNER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const SIGNER_KP = Keypair.random();

test("revokeSponsorshipOps › builds one op per non-claimable-balance kind", () => {
  const entries: SponsoredEntry[] = [
    { kind: "account", owner: OWNER },
    { kind: "trustline", owner: OWNER, asset: `USDC:${ISSUER}` },
    { kind: "offer", owner: OWNER, offerId: "12345" },
    { kind: "data_entry", owner: OWNER, name: "foo" },
    { kind: "signer", owner: OWNER, signerKey: SIGNER_KP.publicKey() },
  ];
  const ops = revokeSponsorshipOps(entries);
  expect(ops).toHaveLength(5);
  const decoded = ops.map((op) => Operation.fromXDRObject(op));
  expect(decoded.map((d) => d.type)).toEqual([
    "revokeAccountSponsorship",
    "revokeTrustlineSponsorship",
    "revokeOfferSponsorship",
    "revokeDataSponsorship",
    "revokeSignerSponsorship",
  ]);
});

test("revokeSponsorshipOps › claimable_balance entries never produce an op (CAP-33: unrevocable without a new sponsor)", () => {
  const entries: SponsoredEntry[] = [{ kind: "claimable_balance", balanceId: "00000000" + "ab".repeat(32) }];
  expect(revokeSponsorshipOps(entries)).toEqual([]);
});

test("revokeSponsorshipOps › signer kind dispatches by StrKey prefix (ed25519)", () => {
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: SIGNER_KP.publicKey() }];
  const decoded = Operation.fromXDRObject(revokeSponsorshipOps(entries)[0]);
  expect(decoded.type).toBe("revokeSignerSponsorship");
  // @ts-expect-error - narrow for the assertion only
  expect(decoded.signer.ed25519PublicKey).toBe(SIGNER_KP.publicKey());
});

test("revokeSponsorshipOps › unrecognized signer key type is skipped, not thrown", () => {
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: "not-a-real-key" }];
  expect(revokeSponsorshipOps(entries)).toEqual([]);
});
