import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { Networks } from "@creit-tech/stellar-wallets-kit/types";
import type { Network } from "@/config/networks";
import { WalletKitSigner } from "@/lib/stellar/signer";
import { walletKitModules } from "./modules";

const KIT_NETWORKS: Record<Network, Networks> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

let initialized = false;

/**
 * Initializes the kit's static singleton on first use and keeps its network in
 * sync afterward. Must only be called client-side (inside useEffect or an
 * event handler) - `StellarWalletsKit.init` touches the DOM and preact
 * signals, which do not exist during Next.js's server render pass.
 */
export function ensureWalletKitInitialized(network: Network): typeof StellarWalletsKit {
  if (typeof window === "undefined") {
    throw new Error("The wallet kit can only be used in the browser.");
  }

  if (!initialized) {
    StellarWalletsKit.init({ modules: walletKitModules(), network: KIT_NETWORKS[network] });
    initialized = true;
  } else {
    StellarWalletsKit.setNetwork(KIT_NETWORKS[network]);
  }

  return StellarWalletsKit;
}

/** The kit's id of the wallet the user connected, or null when none is selected. */
function selectedWalletId(kit: typeof StellarWalletsKit): string | null {
  try {
    return kit.selectedModule.productId;
  } catch {
    return null;
  }
}

/** A signer for `address` through the connected wallet, typed by the wallet it signs with. */
export function walletKitSigner(network: Network, address: string): WalletKitSigner {
  const kit = ensureWalletKitInitialized(network);
  return new WalletKitSigner(
    address,
    (xdr, opts) => ensureWalletKitInitialized(network).signTransaction(xdr, opts),
    { walletId: selectedWalletId(kit) }
  );
}
