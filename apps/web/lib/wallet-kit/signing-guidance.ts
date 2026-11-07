import { WALLET_CONNECT_ID } from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import { XBULL_ID } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { RABET_ID } from "@creit-tech/stellar-wallets-kit/modules/rabet";
import { HANA_ID } from "@creit-tech/stellar-wallets-kit/modules/hana";

const IN_APP =
  "Approve it in the wallet app on your phone. Before you do, check there that the destination and the number of operations match the ones below.";
const IN_EXTENSION =
  "Approve it in your wallet's browser extension. Before you do, check there that the destination and the number of operations match the ones below.";
const IN_WINDOW =
  "Your wallet opens its own window. Before you approve there, check that the destination and the number of operations match the ones below.";
const ANY_WALLET =
  "Approve it in your wallet. Before you do, check there that the destination and the number of operations match the ones below.";

/** Where each offered wallet shows its prompt, keyed by the kit's own ids. */
const GUIDANCE: ReadonlyMap<string, string> = new Map([
  [WALLET_CONNECT_ID, IN_APP],
  [VARIAL_ID, IN_EXTENSION],
  [RABET_ID, IN_EXTENSION],
  [HANA_ID, IN_EXTENSION],
  [XBULL_ID, IN_WINDOW],
  [ALBEDO_ID, IN_WINDOW],
]);

/** What to do in the wallet being asked to sign, by its kit id. */
export function signingGuidance(walletId: string | null): string {
  return (walletId !== null && GUIDANCE.get(walletId)) || ANY_WALLET;
}
