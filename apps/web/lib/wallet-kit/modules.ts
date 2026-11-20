import { WalletConnectModule } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import { FreighterModule, FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule, XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule, ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RabetModule, RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HanaModule, HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";
import { LedgerModule, LEDGER_ID } from "@creit-tech/stellar-wallets-kit/modules/ledger";
import type { ModuleInterface } from "@creit-tech/stellar-wallets-kit/types";
import { walletConnectMetadata, walletConnectProjectId } from "./wallet-connect-config";

/**
 * LOBSTR's own browser-extension module is intentionally excluded: LOBSTR's browser
 * extension is unreliable in practice and not something we can vouch for signing
 * against. LOBSTR mobile is reachable through the WalletConnect module instead. This
 * is a deliberate whitelist, not `defaultModules()` minus Lobstr - the kit ships 13
 * default modules today (most unreviewed by us); add a new one here only after
 * vetting it, never automatically.
 *
 * Ledger is in it: its module talks to the device over WebUSB (opened only on the signing routes,
 * config/security-headers.mjs), its constructor does nothing, and it needs the `Buffer` global the
 * loader sets before the kit starts. Trezor is excluded: its module calls `TrezorConnect.init` in
 * its constructor, which needs a manifest with a contact email and loads Trezor Connect from
 * connect.trezor.io on every page (a new script and frame origin under the CSP), before the user
 * picks any wallet.
 *
 * Note: We import and instantiate only the vetted module classes directly,
 * rather than using `defaultModules({ filterBy })`, because the latter eagerly
 * constructs every default module upfront - including ones like BitgetModule that
 * read `window` in their constructor, which throws outside a browser environment
 * (unit tests, SSR). Manual construction of only the vetted modules avoids this.
 */
export const ALLOWED_DEFAULT_MODULE_IDS: readonly string[] = [
  FREIGHTER_ID,
  XBULL_ID,
  ALBEDO_ID,
  RABET_ID,
  HANA_ID,
  LEDGER_ID,
];

export function vettedDefaultModules(): ModuleInterface[] {
  return [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new RabetModule(),
    new HanaModule(),
    new LedgerModule(),
  ];
}

/**
 * Full module list for `StellarWalletsKit.init`. WalletConnect is included only when
 * a project ID is configured - without it, LOBSTR (reachable only via WalletConnect)
 * is unavailable but the vetted extension wallets and Ledger still work.
 *
 * This must never throw: it runs when the kit first loads, and a throw fails that load,
 * leaving no wallet at all on the account-entry route or `/execute` (the secret-key
 * fallback on the screen where funds get closed still works).
 */
export function walletKitModules(): ModuleInterface[] {
  const projectId = walletConnectProjectId();
  const modules: ModuleInterface[] = [...vettedDefaultModules()];
  if (projectId) {
    modules.push(new WalletConnectModule({ projectId, metadata: walletConnectMetadata() }));
  }
  return modules;
}
