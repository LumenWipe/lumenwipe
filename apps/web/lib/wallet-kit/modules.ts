import { WalletConnectModule } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import { FreighterModule, FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule, XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule, ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RabetModule, RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HanaModule, HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";
import type { ModuleInterface } from "@creit-tech/stellar-wallets-kit/types";

/**
 * LOBSTR's own browser-extension module is intentionally excluded: it cannot
 * sign transactions. LOBSTR mobile is reachable through the WalletConnect
 * module instead. This is a deliberate whitelist, not `defaultModules()` minus
 * Lobstr — the kit ships 13 default modules today (most unreviewed by us);
 * add a new one here only after vetting it, never automatically.
 *
 * Note: We import and instantiate only the vetted five module classes directly,
 * rather than using `defaultModules({ filterBy })`, because the latter eagerly
 * constructs every default module upfront — including ones like BitgetModule that
 * read `window` in their constructor, which throws outside a browser environment
 * (unit tests, SSR). Manual construction of only the vetted modules avoids this.
 */
export const ALLOWED_DEFAULT_MODULE_IDS: readonly string[] = [
  FREIGHTER_ID,
  XBULL_ID,
  ALBEDO_ID,
  RABET_ID,
  HANA_ID,
];

export function vettedDefaultModules(): ModuleInterface[] {
  return [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new RabetModule(),
    new HanaModule(),
  ];
}

/** Full module list for `StellarWalletsKit.init`, including WalletConnect. */
export function walletKitModules(): ModuleInterface[] {
  const projectId = process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
  if (!projectId) {
    throw new Error("Missing NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID.");
  }

  return [
    ...vettedDefaultModules(),
    new WalletConnectModule({
      projectId,
      metadata: {
        name: "LumenWipe",
        description: "Close your Stellar account safely and recover your XLM.",
        url: process.env.NEXT_PUBLIC_APP_URL || "https://lumenwipe.com",
        icons: ["https://lumenwipe.com/favicon-96x96.png"],
      },
    }),
  ];
}
