import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { Networks } from "@creit-tech/stellar-wallets-kit/types";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import type { Network } from "@/config/networks";
import { WalletKitSigner } from "@/lib/stellar/signer";
import { startSignTimeout } from "@/lib/stellar/wallet-timeout";
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
export function selectedWalletId(kit: typeof StellarWalletsKit): string | null {
  try {
    return kit.selectedModule.productId;
  } catch {
    return null;
  }
}

/** Signers already built, one per network, wallet and address. */
const signers = new Map<string, WalletKitSigner>();

/**
 * A signer for `address` through the connected wallet, typed by the wallet it signs with. The same
 * network, wallet and address always get the same signer, so a prompt it gave up on (see
 * `WalletKitSigner.stalePrompt`) is still known when the screen drops the signer and picks it up
 * again, as when a check of the session briefly fails.
 */
export function walletKitSigner(network: Network, address: string): WalletKitSigner {
  const kit = ensureWalletKitInitialized(network);
  const walletId = selectedWalletId(kit);
  const key = `${network}|${walletId ?? ""}|${address}`;
  let signer = signers.get(key);
  if (!signer) {
    signer = new WalletKitSigner(
      address,
      (xdr, opts) => ensureWalletKitInitialized(network).signTransaction(xdr, opts),
      { walletId }
    );
    signers.set(key, signer);
  }
  return signer;
}

/** How long a silent address lookup is waited on before the session is treated as unchecked. */
export const ADDRESS_CHECK_TIMEOUT_MS = 4_000;

/**
 * Wallets whose current account can be read without opening anything. Only Varial (formerly
 * Freighter; the kit's id is `VARIAL_ID`): asked with `skipRequestAccess` it answers from the
 * extension without a prompt. Every other wallet in the kit opens a popup, a QR pairing or a
 * device prompt to answer `getAddress`, so its session cannot be checked silently.
 */
const SILENT_ADDRESS_WALLETS: ReadonlySet<string> = new Set([VARIAL_ID]);

/**
 * The account the selected wallet holds right now, read without any prompt: "unsupported" for a
 * wallet that cannot be asked silently, null when it did not answer in time or failed.
 */
export async function silentWalletAddress(
  kit: typeof StellarWalletsKit
): Promise<string | null | "unsupported"> {
  const walletId = selectedWalletId(kit);
  if (!walletId || !SILENT_ADDRESS_WALLETS.has(walletId)) return "unsupported";
  const timer = startSignTimeout(ADDRESS_CHECK_TIMEOUT_MS);
  try {
    const answer = kit.selectedModule.getAddress({ skipRequestAccess: true }).then(
      ({ address }) => address || null,
      () => null
    );
    return await Promise.race([answer, timer.expired.then(() => null)]);
  } catch {
    return null;
  } finally {
    timer.cancel();
  }
}
