import { test, expect } from "bun:test";
import { Keypair, Operation, StrKey, xdr } from "@stellar/stellar-sdk";
import { revokeSponsorshipOps } from "@/lib/stellar/tx-builder/sponsorship";
import type { SponsoredEntry } from "@lumenwipe/types";
import { decodeOperation } from "../support/decoded-operation";

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

test("revokeSponsorshipOps › a pool share trustline is revoked on its owner's line in that pool", () => {
  const poolId = "d714bc2e56f74a4a4de2e81284a35b6fe09582f081bf785fc698310895c2d845";
  const entries: SponsoredEntry[] = [{ kind: "pool_share_trustline", owner: OWNER, poolId }];
  const decoded = decodeOperation(revokeSponsorshipOps(entries)[0], "revokeTrustlineSponsorship");
  expect(decoded.account).toBe(OWNER);
  expect("getLiquidityPoolId" in decoded.asset && decoded.asset.getLiquidityPoolId()).toBe(poolId);
});

test("revokeSponsorshipOps › claimable_balance entries never produce an op (CAP-33: unrevocable without a new sponsor)", () => {
  const entries: SponsoredEntry[] = [
    { kind: "claimable_balance", balanceId: "00000000" + "ab".repeat(32) },
  ];
  expect(revokeSponsorshipOps(entries)).toEqual([]);
});

test("revokeSponsorshipOps › signer kind dispatches by StrKey prefix (ed25519)", () => {
  const entries: SponsoredEntry[] = [
    { kind: "signer", owner: OWNER, signerKey: SIGNER_KP.publicKey() },
  ];
  const decoded = decodeOperation(revokeSponsorshipOps(entries)[0], "revokeSignerSponsorship");
  expect(decoded.type).toBe("revokeSignerSponsorship");
  expect(decoded.signer.ed25519PublicKey).toBe(SIGNER_KP.publicKey());
});

test("revokeSponsorshipOps › unrecognized signer key type is skipped, not thrown", () => {
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: "not-a-real-key" }];
  expect(revokeSponsorshipOps(entries)).toEqual([]);
});

test("revokeSponsorshipOps › signer kind dispatches by StrKey prefix (ed25519 signed payload)", () => {
  const payloadKey = StrKey.encodeSignedPayload(
    new xdr.SignerKeyEd25519SignedPayload({
      ed25519: SIGNER_KP.rawPublicKey(),
      payload: Buffer.from("cafebabe", "hex"),
    }).toXDR()
  );
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: payloadKey }];
  const decoded = decodeOperation(revokeSponsorshipOps(entries)[0]!, "revokeSignerSponsorship");
  expect(decoded.type).toBe("revokeSignerSponsorship");
});

test("revokeSponsorshipOps › signer kind dispatches by StrKey prefix (preauth_tx)", () => {
  const preAuthKey = StrKey.encodePreAuthTx(SIGNER_KP.rawPublicKey());
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: preAuthKey }];
  const decoded = decodeOperation(revokeSponsorshipOps(entries)[0]!, "revokeSignerSponsorship");
  expect(decoded.type).toBe("revokeSignerSponsorship");
  expect(decoded.signer.preAuthTx).toBeDefined();
});

test("revokeSponsorshipOps › signer kind dispatches by StrKey prefix (hash_x)", () => {
  const hashXKey = StrKey.encodeSha256Hash(SIGNER_KP.rawPublicKey());
  const entries: SponsoredEntry[] = [{ kind: "signer", owner: OWNER, signerKey: hashXKey }];
  const decoded = decodeOperation(revokeSponsorshipOps(entries)[0]!, "revokeSignerSponsorship");
  expect(decoded.type).toBe("revokeSignerSponsorship");
  expect(decoded.signer.sha256Hash).toBeDefined();
});
