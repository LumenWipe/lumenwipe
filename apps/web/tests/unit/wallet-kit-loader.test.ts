import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { LocalStorageKeys, ModuleType, Networks } from "@creit-tech/stellar-wallets-kit/types";
import type { ModuleInterface } from "@creit-tech/stellar-wallets-kit/types";
import {
  forgetStoredWalletSession,
  hasStoredWalletSession,
  provideBuffer,
  walletKitLoader,
  WALLET_KIT_LOAD_FAILED,
  WalletKitLoadError,
  type WalletKit,
  type WalletKitBundle,
} from "@/lib/wallet-kit/loader";
import { toUserMessage } from "@/lib/utils/user-error";

afterEach(() => {
  mock.restore();
  localStorage.clear();
});

/** A stand-in for the kit's code: records how the singleton was set up, never fetches anything. */
function standIn() {
  const notStubbed = () => Promise.reject(new Error("the vetted stand-in never signs"));
  const modules: ModuleInterface[] = [
    {
      moduleType: ModuleType.HOT_WALLET,
      productId: "vetted",
      productName: "Vetted",
      productUrl: "https://wallet.invalid",
      productIcon: "",
      isAvailable: async () => true,
      getAddress: notStubbed,
      signTransaction: notStubbed,
      signAuthEntry: notStubbed,
      signMessage: notStubbed,
      getNetwork: notStubbed,
    },
  ];
  const bufferAtInit: unknown[] = [];
  const kit = {
    init: mock((_params: { modules: ModuleInterface[]; network: Networks }) => {
      bufferAtInit.push((globalThis as { Buffer?: unknown }).Buffer);
    }),
    setNetwork: mock((_network: Networks) => {}),
  };
  const polyfill = { name: "the buffer package's Buffer" };
  const bundle: WalletKitBundle = {
    kit: kit as unknown as WalletKit,
    modules: mock(() => modules),
    Buffer: polyfill,
  };
  const importKit = mock(async () => bundle);
  return { kit, bundle, modules, importKit, polyfill, bufferAtInit };
}

/** Runs `fn` with no global `Buffer`, as in a browser, and puts the runtime's own back after. */
async function withoutGlobalBuffer(fn: () => Promise<void>): Promise<void> {
  const global = globalThis as { Buffer?: unknown };
  const own = global.Buffer;
  delete global.Buffer;
  try {
    await fn();
  } finally {
    global.Buffer = own;
  }
}

test("wallet kit loader › a browser with no Buffer gets the buffer package's, before the kit starts", async () => {
  await withoutGlobalBuffer(async () => {
    const { importKit, polyfill, bufferAtInit } = standIn();
    await walletKitLoader(importKit).ensure("testnet");
    expect(bufferAtInit).toEqual([polyfill]);
    expect((globalThis as { Buffer?: unknown }).Buffer).toBe(polyfill);
  });
});

test("wallet kit loader › a Buffer already there is never replaced", async () => {
  const own = (globalThis as { Buffer?: unknown }).Buffer;
  expect(own).toBeDefined();
  const { importKit, bufferAtInit } = standIn();
  await walletKitLoader(importKit).ensure("testnet");
  expect(bufferAtInit).toEqual([own]);
  expect((globalThis as { Buffer?: unknown }).Buffer).toBe(own);
});

test("provideBuffer › sets the polyfill only where there is no Buffer", () => {
  const empty: { Buffer?: unknown } = {};
  provideBuffer(empty, "polyfill");
  expect(empty.Buffer).toBe("polyfill");
  const taken: { Buffer?: unknown } = { Buffer: "own" };
  provideBuffer(taken, "polyfill");
  expect(taken.Buffer).toBe("own");
});

test("wallet kit loader › nothing is imported until the kit is first asked for", () => {
  const { importKit } = standIn();
  walletKitLoader(importKit);
  expect(importKit).not.toHaveBeenCalled();
});

test("wallet kit loader › the first use initializes once, with the vetted modules and its network", async () => {
  const { kit, bundle, modules, importKit } = standIn();
  const loader = walletKitLoader(importKit);
  expect(loader.current()).toBeNull();

  expect(await loader.ensure("mainnet")).toBe(bundle.kit);
  expect(kit.init).toHaveBeenCalledTimes(1);
  expect(kit.init.mock.calls[0]?.[0]).toEqual({ modules, network: Networks.PUBLIC });
  expect(kit.setNetwork).toHaveBeenLastCalledWith(Networks.PUBLIC);
  expect(loader.current()).toBe(bundle.kit);
});

test("wallet kit loader › later uses never initialize again and move the kit to their network", async () => {
  const { kit, importKit } = standIn();
  const loader = walletKitLoader(importKit);
  await loader.ensure("mainnet");
  await loader.ensure("testnet");
  expect(importKit).toHaveBeenCalledTimes(1);
  expect(kit.init).toHaveBeenCalledTimes(1);
  expect(kit.setNetwork).toHaveBeenLastCalledWith(Networks.TESTNET);
});

test("wallet kit loader › uses that start together share one import and one initialization", async () => {
  const { kit, importKit } = standIn();
  const loader = walletKitLoader(importKit);
  await Promise.all([loader.ensure("testnet"), loader.ensure("testnet"), loader.ensure("testnet")]);
  expect(importKit).toHaveBeenCalledTimes(1);
  expect(kit.init).toHaveBeenCalledTimes(1);
});

test("wallet kit loader › code that fails to load is a plain error, and the next use tries again", async () => {
  const { kit, importKit } = standIn();
  const bundle = await importKit();
  importKit.mockClear();
  importKit.mockImplementationOnce(async () => {
    throw new TypeError("Failed to fetch dynamically imported module");
  });
  const loader = walletKitLoader(importKit);

  const failed = await loader.ensure("testnet").catch((err: unknown) => err);
  expect(failed).toBeInstanceOf(WalletKitLoadError);
  expect(toUserMessage(failed, "wallet")).toBe(WALLET_KIT_LOAD_FAILED);
  expect(loader.current()).toBeNull();
  expect(kit.init).not.toHaveBeenCalled();

  importKit.mockImplementation(async () => bundle);
  expect(await loader.ensure("testnet")).toBe(bundle.kit);
  expect(importKit).toHaveBeenCalledTimes(2);
});

test("wallet kit loader › a kit that throws while initializing is not kept", async () => {
  const { kit, bundle, importKit } = standIn();
  kit.init.mockImplementationOnce(() => {
    throw new Error("init failed");
  });
  const loader = walletKitLoader(importKit);
  expect(await loader.ensure("testnet").catch((err: unknown) => err)).toBeInstanceOf(
    WalletKitLoadError
  );
  expect(loader.current()).toBeNull();
  expect(await loader.ensure("testnet")).toBe(bundle.kit);
  expect(kit.init).toHaveBeenCalledTimes(2);
});

test("stored wallet session › only an address the kit saved counts", () => {
  expect(hasStoredWalletSession()).toBe(false);
  localStorage.setItem(LocalStorageKeys.activeAddress, "");
  expect(hasStoredWalletSession()).toBe(false);
  localStorage.setItem(LocalStorageKeys.selectedModuleId, "varial");
  expect(hasStoredWalletSession()).toBe(false);
  localStorage.setItem(LocalStorageKeys.activeAddress, "GSAVED");
  expect(hasStoredWalletSession()).toBe(true);
});

test("stored wallet session › storage that cannot be read holds no session", () => {
  spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(hasStoredWalletSession()).toBe(false);
});

test("stored wallet session › forgetting it removes the saved address, and blocked storage is no error", () => {
  localStorage.setItem(LocalStorageKeys.activeAddress, "GSAVED");
  forgetStoredWalletSession();
  expect(hasStoredWalletSession()).toBe(false);

  spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => forgetStoredWalletSession()).not.toThrow();
});
