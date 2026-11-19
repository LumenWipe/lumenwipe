import { expect, mock, spyOn, test } from "bun:test";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  ensureWalletKitInitialized,
  silentWalletAddress,
  walletKitSigner,
} from "@/lib/wallet-kit/client";
import * as loader from "@/lib/wallet-kit/loader";
import { WalletNotUsableError } from "@/lib/stellar/signer";
import { vettedDefaultModules } from "@/lib/wallet-kit/modules";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";

const address = Keypair.random().publicKey();
const SHOWN = { fingerprintShown: true };

/** A kit whose selected wallet is `productId`, answering `getAddress` with `answer`. */
function kitWith(productId: string, answer: () => Promise<{ address: string }>) {
  const getAddress = mock((_params?: { skipRequestAccess?: boolean }) => answer());
  const kit = { selectedModule: { productId, getAddress } };
  return { kit: kit as unknown as Parameters<typeof silentWalletAddress>[0], getAddress };
}

test("silent wallet address › Freighter is asked without requesting access, so no prompt opens", async () => {
  const { kit, getAddress } = kitWith(VARIAL_ID, async () => ({ address }));
  expect(await silentWalletAddress(kit)).toBe(address);
  expect(getAddress).toHaveBeenCalledTimes(1);
  expect(getAddress.mock.calls[0]?.[0]).toEqual({ skipRequestAccess: true });
});

test.each(["xbull", "albedo", "rabet", "hana", "wallet_connect", "LEDGER"])(
  "silent wallet address › %s cannot be asked without a prompt and is never asked",
  async (productId) => {
    const { kit, getAddress } = kitWith(productId, async () => ({ address }));
    expect(await silentWalletAddress(kit)).toBe("unsupported");
    expect(getAddress).not.toHaveBeenCalled();
  }
);

test("silent wallet address › no selected wallet is unsupported", async () => {
  const kit = {
    get selectedModule(): never {
      throw new Error("Please set the wallet first");
    },
  } as unknown as Parameters<typeof silentWalletAddress>[0];
  expect(await silentWalletAddress(kit)).toBe("unsupported");
});

test.each([
  ["fails", () => Promise.reject(new Error("locked"))],
  ["answers with no address", () => Promise.resolve({ address: "" })],
])("silent wallet address › a wallet that %s is unchecked, not connected", async (_, answer) => {
  const { kit } = kitWith(VARIAL_ID, answer);
  expect(await silentWalletAddress(kit)).toBeNull();
});

test("silent wallet address › the Varial module the app really offers is the one asked silently", async () => {
  // Built by the installed kit, as the app builds it: its id must be the one the lookup accepts.
  const varial = vettedDefaultModules().find((m) => m.productId === VARIAL_ID);
  expect(varial).toBeDefined();
  const getAddress = spyOn(varial!, "getAddress").mockImplementation(async () => ({ address }));
  const kit = { selectedModule: varial } as unknown as Parameters<typeof silentWalletAddress>[0];

  expect(await silentWalletAddress(kit)).toBe(address);
  expect(getAddress).toHaveBeenCalledWith({ skipRequestAccess: true });
});

// The kit loader is one per page, so this file loads a stand-in kit once: the test that needs no
// kit loaded runs first. No other test file loads it through the client.
const signTransaction = mock(async (_xdr: string, _opts: unknown) => ({ signedTxXdr: "signed" }));
const standIn = {
  init: mock(() => {}),
  setNetwork: mock(() => {}),
  selectedModule: { productId: VARIAL_ID },
  signTransaction,
};

test("wallet kit › outside a browser it refuses before importing anything", async () => {
  const load = spyOn(loader, "importWalletKit").mockImplementation(async () => {
    throw new Error("imported outside a browser");
  });
  const browser = Object.getOwnPropertyDescriptor(globalThis, "window");
  Reflect.deleteProperty(globalThis, "window");
  try {
    expect(await ensureWalletKitInitialized("testnet").catch((err: unknown) => err)).toBeInstanceOf(
      Error
    );
  } finally {
    if (browser) Object.defineProperty(globalThis, "window", browser);
  }
  expect(load).not.toHaveBeenCalled();
  load.mockRestore();
});

test("wallet signer › before the kit has loaded there is no signer, not one without a wallet", () => {
  expect(() => walletKitSigner("testnet", address, SHOWN)).toThrow(loader.WalletKitLoadError);
});

test("wallet signer › the same network, wallet and address always get the same signer", async () => {
  const load = spyOn(loader, "importWalletKit").mockImplementation(async () => ({
    kit: standIn as unknown as loader.WalletKit,
    modules: () => [],
    Buffer: globalThis.Buffer,
  }));
  await ensureWalletKitInitialized("testnet");
  load.mockRestore();

  const other = Keypair.random().publicKey();
  const first = walletKitSigner("testnet", address, SHOWN);
  expect(first.walletId).toBe(VARIAL_ID);
  expect(first.fingerprintShown).toBe(true);
  expect(walletKitSigner("testnet", address, SHOWN)).toBe(first);
  expect(walletKitSigner("testnet", other, SHOWN)).not.toBe(first);
  expect(walletKitSigner("mainnet", address, SHOWN)).not.toBe(first);
  const hidden = walletKitSigner("testnet", address, { fingerprintShown: false });
  expect(hidden).not.toBe(first);
  expect(hidden.fingerprintShown).toBe(false);
});

test("wallet signer › signs through the loaded kit with the signer's own network and address", async () => {
  standIn.setNetwork.mockClear();
  const signer = walletKitSigner("testnet", address, SHOWN);
  const signWithKit = (
    signer as unknown as {
      signWithKit: (
        x: string,
        o: { networkPassphrase: string; address: string }
      ) => Promise<unknown>;
    }
  ).signWithKit;
  const opts = { networkPassphrase: Networks.TESTNET, address };
  await signWithKit("xdr", opts);
  expect(signTransaction).toHaveBeenCalledWith("xdr", opts);
  expect(standIn.setNetwork).toHaveBeenCalledWith(Networks.TESTNET);
  expect(standIn.init).toHaveBeenCalledTimes(1);
});

test("wallet signer › the kit is handed nonBlindTx unchanged, though its own type omits it", async () => {
  signTransaction.mockClear();
  const signer = walletKitSigner("testnet", address, SHOWN);
  const signWithKit = (
    signer as unknown as { signWithKit: (x: string, o: object) => Promise<unknown> }
  ).signWithKit;
  const opts = { networkPassphrase: Networks.TESTNET, address, nonBlindTx: true };
  await signWithKit("xdr", opts);
  expect(signTransaction).toHaveBeenCalledWith("xdr", opts);
});

test("wallet signer › a wallet selected since the signer was built is never asked with its options", async () => {
  signTransaction.mockClear();
  const signer = walletKitSigner("testnet", address, SHOWN);
  expect(signer.walletId).toBe(VARIAL_ID);
  standIn.selectedModule.productId = "LEDGER";
  try {
    const signWithKit = (
      signer as unknown as { signWithKit: (x: string, o: object) => Promise<unknown> }
    ).signWithKit;
    const refused = await signWithKit("xdr", {
      networkPassphrase: Networks.TESTNET,
      address,
    }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(WalletNotUsableError);
    expect(signTransaction).not.toHaveBeenCalled();
  } finally {
    standIn.selectedModule.productId = VARIAL_ID;
  }
});
