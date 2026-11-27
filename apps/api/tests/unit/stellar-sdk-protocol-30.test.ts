import { expect, test } from "bun:test";
import { Keypair, xdr } from "@stellar/stellar-sdk";

// docs/architecture.md says the pinned SDK decodes Protocol 30 ledger headers. CAP-88 added the
// close-time arms of StellarValueExt (a millisecond close time next to the node's signature);
// if a Renovate bump ever drops them, this fails before that sentence goes stale.
test("the pinned SDK round-trips the CAP-88 signed millisecond close-time arm of a ledger value", () => {
  const signature = new xdr.LedgerCloseValueSignature({
    nodeId: xdr.PublicKey.publicKeyTypeEd25519(Keypair.random().rawPublicKey()),
    signature: new Uint8Array(64).fill(1),
  });
  const ext = xdr.StellarValueExt.stellarValueSignedMs(
    new xdr.StellarValueSignedMsValue({ closeTimeMs: 1764230000123n, lcValueSignature: signature })
  );
  const value = new xdr.StellarValue({
    txSetHash: new Uint8Array(32),
    closeTime: 1764230000n,
    upgrades: [],
    ext,
  });

  const decoded = xdr.StellarValue.fromXDR(value.toXDR("base64"), "base64");

  expect(decoded.ext).toBeInstanceOf(xdr.StellarValueExtSignedMs);
  expect((decoded.ext as xdr.StellarValueExtSignedMs).signedMsValue.closeTimeMs).toBe(
    1764230000123n
  );
});
