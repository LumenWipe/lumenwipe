import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import CosignStation from "@/components/cosign/CosignStation";
import * as walletConnection from "@/hooks/useWalletKitConnection";
import { serializeCosignArtifact } from "@/lib/cosign/artifact";
import { fingerprintOf } from "@/lib/cosign/station-checks";
import { toHex } from "@/lib/stellar/hex";
import type { WalletKitSigner } from "@/lib/stellar/signer";
import * as walletClient from "@/lib/wallet-kit/client";

const master = Keypair.random();
const cosigner = Keypair.random();
const ACCOUNT = master.publicKey();

function buildRequest() {
  return new TransactionBuilder(new Account(ACCOUNT, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({ signer: { ed25519PublicKey: cosigner.publicKey(), weight: 0 } })
    )
    .addOperation(Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }))
    .setTimeout(300)
    .build();
}

const accountBody = {
  address: ACCOUNT,
  network: "testnet",
  sequence: "100",
  signers: [
    { key: ACCOUNT, weight: 1, type: "ed25519_public_key" },
    { key: cosigner.publicKey(), weight: 1, type: "ed25519_public_key" },
  ],
  thresholds: { low: 0, med: 2, high: 2 },
  authImmutable: false,
};

let fetched: { url: string; init?: RequestInit }[];
const sign = mock(async (xdr: string, passphrase: string) => {
  const tx = TransactionBuilder.fromXdr(xdr, passphrase);
  tx.sign(cosigner);
  return tx.toEnvelope().toXDR("base64");
});

beforeEach(() => {
  fetched = [];
  sign.mockClear();
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    fetched.push({ url: String(url), init });
    return new Response(JSON.stringify(accountBody), { status: 200 });
  }) as typeof fetch);
  spyOn(walletConnection, "useWalletKitConnection").mockImplementation(
    () =>
      ({
        address: cosigner.publicKey(),
        status: "connected",
        network: "yes",
        verified: true,
        checking: false,
        connecting: false,
        error: null,
        networkConfirmed: false,
        confirmNetwork: () => {},
        beforeSigning: () => async () => {},
        connect: async () => {},
        disconnect: async () => {},
      }) as never
  );
  spyOn(walletClient, "walletKitSigner").mockImplementation(
    () => ({ publicKey: cosigner.publicKey(), sign }) as unknown as WalletKitSigner
  );
});

afterEach(() => mock.restore());

async function importRequest(): Promise<string> {
  const tx = buildRequest();
  render(<CosignStation />);
  fireEvent.click(screen.getByRole("radio", { name: "Testnet" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Account to cosign for/ }), {
    target: { value: ACCOUNT },
  });
  const pasted = await screen.findByRole("textbox", { name: /Or paste the request/ });
  fireEvent.change(pasted, {
    target: {
      value: serializeCosignArtifact({
        direction: "request",
        network: "testnet",
        account: ACCOUNT,
        envelope: tx.toEnvelope().toXDR("base64"),
      }),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check request" }));
  await screen.findByText(/sole/);
  return toHex(tx.hash());
}

test("states the sole control it gives before anything can be signed", async () => {
  await importRequest();
  expect(screen.getByText(/sole/).textContent).toContain(
    `Signing this gives the master key, ${ACCOUNT}, sole control of this account.`
  );
  expect(screen.getByText(cosigner.publicKey())).toBeTruthy();
});

test("signs only after the typed fingerprint matches and the signer is asked by a click", async () => {
  const hash = await importRequest();
  const button = (): HTMLButtonElement =>
    screen.getByRole("button", { name: "Sign this transaction" }) as HTMLButtonElement;
  const field = screen.getByRole("textbox", { name: /Transaction hash characters/ });
  await waitFor(() => expect(screen.getByText(/Connected|connected/i)).toBeTruthy());
  expect(button().disabled).toBe(true);

  fireEvent.change(field, { target: { value: `${hash.slice(0, 8)}00000000` } });
  expect(screen.getByText(/The characters do not match/)).toBeTruthy();
  expect(button().disabled).toBe(true);

  fireEvent.change(field, { target: { value: fingerprintOf(hash) } });
  expect(button().disabled).toBe(false);
  expect(sign).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(button());
  });
  expect(sign).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "Save response file" })).toBeTruthy();
});

test("sends the API only the network and the account, and stores nothing", async () => {
  const setItem = spyOn(Storage.prototype, "setItem");
  const hash = await importRequest();
  fireEvent.change(screen.getByRole("textbox", { name: /Transaction hash characters/ }), {
    target: { value: fingerprintOf(hash) },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign this transaction" }));
  });
  await screen.findByRole("button", { name: "Save response file" });

  expect(fetched).toEqual([{ url: `/api/testnet/account/${ACCOUNT}`, init: expect.anything() }]);
  expect(fetched[0]!.init?.body).toBeUndefined();
  expect(fetched[0]!.init?.method).toBeUndefined();
  expect(setItem).not.toHaveBeenCalled();
});

test("refuses a request for another account with a plain message", async () => {
  render(<CosignStation />);
  fireEvent.click(screen.getByRole("radio", { name: "Testnet" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Account to cosign for/ }), {
    target: { value: ACCOUNT },
  });
  const pasted = await screen.findByRole("textbox", { name: /Or paste the request/ });
  const other = Keypair.random().publicKey();
  const tx = new TransactionBuilder(new Account(other, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }))
    .setTimeout(300)
    .build();
  fireEvent.change(pasted, {
    target: {
      value: serializeCosignArtifact({
        direction: "request",
        network: "testnet",
        account: other,
        envelope: tx.toEnvelope().toXDR("base64"),
      }),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check request" }));
  expect(await screen.findByText("This request is for another account.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign this transaction" })).toBeNull();
});

test("drops a checked request when the account changes", async () => {
  await importRequest();
  fireEvent.change(screen.getByRole("textbox", { name: /Account to cosign for/ }), {
    target: { value: Keypair.random().publicKey() },
  });
  await waitFor(() => expect(screen.queryByText(/sole/)).toBeNull());
  expect(screen.queryByRole("button", { name: "Sign this transaction" })).toBeNull();
});

test("never shows a request checked for an account the cosigner has since changed", async () => {
  render(<CosignStation />);
  fireEvent.click(screen.getByRole("radio", { name: "Testnet" }));
  const accountField = screen.getByRole("textbox", { name: /Account to cosign for/ });
  fireEvent.change(accountField, { target: { value: ACCOUNT } });
  const fileInput = (await screen.findByLabelText("Request file")) as HTMLInputElement;
  let release: (text: string) => void = () => {};
  const file = {
    size: 1,
    text: () => new Promise<string>((resolve) => (release = resolve)),
  } as unknown as File;
  fireEvent.change(fileInput, { target: { files: [file] } });
  fireEvent.change(accountField, { target: { value: Keypair.random().publicKey() } });
  await act(async () => {
    release(
      serializeCosignArtifact({
        direction: "request",
        network: "testnet",
        account: ACCOUNT,
        envelope: buildRequest().toEnvelope().toXDR("base64"),
      })
    );
  });
  expect(screen.queryByText(/sole/)).toBeNull();
});
