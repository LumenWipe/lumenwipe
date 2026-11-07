import { expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { silentWalletAddress, walletKitSigner } from "@/lib/wallet-kit/client";
import { vettedDefaultModules } from "@/lib/wallet-kit/modules";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";

const address = Keypair.random().publicKey();

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

test.each(["xbull", "albedo", "rabet", "hana", "wallet_connect"])(
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

test("wallet signer › the same network, wallet and address always get the same signer", () => {
  const other = Keypair.random().publicKey();
  const first = walletKitSigner("testnet", address);
  expect(walletKitSigner("testnet", address)).toBe(first);
  expect(walletKitSigner("testnet", other)).not.toBe(first);
  expect(walletKitSigner("mainnet", address)).not.toBe(first);
});
