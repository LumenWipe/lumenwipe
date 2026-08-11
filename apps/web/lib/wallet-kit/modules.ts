import { WalletConnectModule } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import { FreighterModule, FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule, XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule, ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RabetModule, RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HanaModule, HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";
import type { ModuleInterface } from "@creit-tech/stellar-wallets-kit/types";

/**
 * LOBSTR's own browser-extension module is intentionally excluded: LOBSTR's browser
 * extension is unreliable in practice and not something we can vouch for signing
 * against. LOBSTR mobile is reachable through the WalletConnect module instead. This
 * is a deliberate whitelist, not `defaultModules()` minus Lobstr — the kit ships 13
 * default modules today (most unreviewed by us); add a new one here only after
 * vetting it, never automatically.
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

/**
 * Full module list for `StellarWalletsKit.init`. WalletConnect is included only when
 * a project ID is configured — without it, LOBSTR (reachable only via WalletConnect)
 * is unavailable but the five vetted extension wallets still work.
 *
 * This must never throw: it runs inside a React effect on both the account-entry
 * route and `/execute`, with no error boundary scoped tighter than the whole page
 * in either case, so an uncaught error here would take the rest of that page's UI
 * down too — including the secret-key fallback on the screen where funds get closed.
 */
export function walletKitModules(): ModuleInterface[] {
  const projectId = process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
  const modules: ModuleInterface[] = [...vettedDefaultModules()];

  if (projectId) {
    modules.push(
      new WalletConnectModule({
        projectId,
        metadata: {
          name: "LumenWipe",
          description: "Close your Stellar account safely and recover your XLM.",
          url: process.env.NEXT_PUBLIC_APP_URL || "https://lumenwipe.com",
          icons: ["https://lumenwipe.com/favicon-96x96.png"],
        },
      })
    );
  } else {
    // Dev/ops visibility only — never shown to end users, and this must not throw.
    console.warn(
      "NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID is not set — WalletConnect (and LOBSTR) will be unavailable."
    );
  }

  return modules;
}
