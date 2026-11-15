import type { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import {
  LocalStorageKeys,
  Networks,
  type ModuleInterface,
} from "@creit-tech/stellar-wallets-kit/types";
import type { Network } from "@/config/networks";
import { UserFacingError } from "@/lib/utils/user-error";

export type WalletKit = typeof StellarWalletsKit;

/** What the lazily loaded kit code provides: the kit's singleton and the vetted module list. */
export interface WalletKitBundle {
  kit: WalletKit;
  modules: () => ModuleInterface[];
}

const KIT_NETWORKS: Record<Network, Networks> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

export const WALLET_KIT_LOAD_FAILED =
  "The wallet connection could not load. Check your connection and try again.";

/** The kit's code could not be loaded or set up, or was asked for before it was. */
export class WalletKitLoadError extends UserFacingError {
  constructor(readonly reason?: unknown) {
    super(WALLET_KIT_LOAD_FAILED);
    this.name = "WalletKitLoadError";
  }
}

/** The one place the wallet kit's code is fetched: never at page load, only on first use. */
export function importWalletKit(): Promise<WalletKitBundle> {
  return Promise.all([import("@creit-tech/stellar-wallets-kit/sdk"), import("./modules")]).then(
    ([sdk, modules]) => ({
      kit: sdk.StellarWalletsKit,
      modules: modules.walletKitModules,
    })
  );
}

export interface WalletKitLoader {
  /** Loads and initializes the kit once, then sets it to `network` on every call. */
  ensure(network: Network): Promise<WalletKit>;
  /** The initialized kit, or null before a load has finished. */
  current(): WalletKit | null;
}

export function walletKitLoader(importKit: () => Promise<WalletKitBundle>): WalletKitLoader {
  let loading: Promise<WalletKit> | null = null;
  let loaded: WalletKit | null = null;

  function load(network: Network): Promise<WalletKit> {
    if (loading) return loading;
    const attempt = Promise.resolve()
      .then(importKit)
      .then(({ kit, modules }) => {
        kit.init({ modules: modules(), network: KIT_NETWORKS[network] });
        loaded = kit;
        return kit;
      })
      .catch((cause: unknown) => {
        // A failed load is never kept: the next call tries again from the start.
        if (loading === attempt) loading = null;
        throw new WalletKitLoadError(cause);
      });
    loading = attempt;
    return attempt;
  }

  return {
    ensure: (network) =>
      load(network).then((kit) => {
        kit.setNetwork(KIT_NETWORKS[network]);
        return kit;
      }),
    current: () => loaded,
  };
}

/** Whether the kit saved a connected address in this browser, the only case a session restores. */
export function hasStoredWalletSession(): boolean {
  try {
    return !!globalThis.localStorage?.getItem(LocalStorageKeys.activeAddress);
  } catch {
    return false;
  }
}

/** Forgets the saved address without the kit, so a session cannot come back on the next load. */
export function forgetStoredWalletSession(): void {
  try {
    globalThis.localStorage?.removeItem(LocalStorageKeys.activeAddress);
  } catch {
    // Storage that cannot be written holds nothing to restore either.
  }
}
