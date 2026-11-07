import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { WALLET_CONNECT_ID } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import { XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";
import PreSignPanel from "@/components/execution/PreSignPanel";
import { hashFingerprint, signingPromptFor } from "@/lib/execution/signing-prompt";
import { signingGuidance } from "@/lib/wallet-kit/signing-guidance";
import { toHex } from "@/lib/stellar/hex";

afterEach(cleanup);

const source = Keypair.random();
const destination = Keypair.random().publicKey();

function envelope(ops: "merge" | "trustline"): string {
  const builder = new TransactionBuilder(new Account(source.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  if (ops === "merge") {
    builder.addOperation(
      Operation.changeTrust({ asset: new Asset("ABC", destination), limit: "0" })
    );
    builder.addOperation(Operation.accountMerge({ destination }));
  } else {
    builder.addOperation(
      Operation.changeTrust({ asset: new Asset("ABC", destination), limit: "0" })
    );
  }
  return builder.build().toXDR();
}

function hashOf(xdr: string): string {
  return toHex(TransactionBuilder.fromXDR(xdr, Networks.TESTNET).hash());
}

test("signing-prompt › reads the destination and operation count from the envelope it is given", () => {
  const xdr = envelope("merge");
  expect(signingPromptFor(WALLET_CONNECT_ID, xdr, Networks.TESTNET, hashOf(xdr))).toEqual({
    walletId: WALLET_CONNECT_ID,
    hash: hashOf(xdr),
    summary: { mergeDestination: destination, operationCount: 2 },
  });
  expect(signingPromptFor(null, envelope("trustline"), Networks.TESTNET, "ab").summary).toEqual({
    mergeDestination: null,
    operationCount: 1,
  });
});

test("signing-prompt › an envelope that cannot be read keeps the hash and drops the summary", () => {
  const prompt = signingPromptFor(VARIAL_ID, "not an envelope", Networks.TESTNET, "f".repeat(64));
  expect(prompt).toEqual({ walletId: VARIAL_ID, hash: "f".repeat(64), summary: null });
});

test("signing-prompt › the fingerprint is the hash's first and last eight characters", () => {
  const hash = hashOf(envelope("merge"));
  expect(hashFingerprint(hash)).toBe(`${hash.slice(0, 8)}…${hash.slice(-8)}`);
});

test("signing-guidance › each offered wallet is told where its prompt is, by the kit's id", () => {
  expect(signingGuidance(WALLET_CONNECT_ID)).toContain("wallet app on your phone");
  for (const id of [VARIAL_ID, RABET_ID, HANA_ID]) {
    expect(signingGuidance(id)).toContain("browser extension");
  }
  for (const id of [XBULL_ID, ALBEDO_ID]) {
    expect(signingGuidance(id)).toContain("opens its own window");
  }
  expect(signingGuidance(null)).toBe(signingGuidance("some-other-wallet"));
  expect(signingGuidance(null)).toContain("Approve it in your wallet.");
});

test("pre-sign panel › shows the destination, the operation count and the hash fingerprint", () => {
  const xdr = envelope("merge");
  render(
    <PreSignPanel
      prompt={signingPromptFor(WALLET_CONNECT_ID, xdr, Networks.TESTNET, hashOf(xdr))}
    />
  );
  expect(screen.getByTestId("pre-sign-destination").textContent).toBe(destination);
  expect(screen.getByTestId("pre-sign-operations").textContent).toBe("2");
  expect(screen.getByTestId("pre-sign-hash").textContent).toBe(hashFingerprint(hashOf(xdr)));
  expect(screen.getByText(signingGuidance(WALLET_CONNECT_ID))).toBeDefined();
});

test("pre-sign panel › a transaction without a merge says so, and an unreadable one shows the hash alone", () => {
  const xdr = envelope("trustline");
  render(<PreSignPanel prompt={signingPromptFor(VARIAL_ID, xdr, Networks.TESTNET, hashOf(xdr))} />);
  expect(screen.getByTestId("pre-sign-destination").textContent).toBe(
    "No account merge in this transaction"
  );
  cleanup();

  render(<PreSignPanel prompt={{ walletId: null, hash: "a".repeat(64), summary: null }} />);
  expect(screen.queryByTestId("pre-sign-destination")).toBeNull();
  expect(screen.queryByTestId("pre-sign-operations")).toBeNull();
  expect(screen.getByTestId("pre-sign-hash").textContent).toBe(hashFingerprint("a".repeat(64)));
});
