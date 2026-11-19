import {
  ALBEDO_ID,
  HANA_ID,
  LEDGER_ID,
  RABET_ID,
  VARIAL_ID,
  WALLET_CONNECT_ID,
  XBULL_ID,
} from "./wallet-ids";

const IN_APP =
  "Approve it in the wallet app on your phone. Before you do, check there that the destination and the number of operations match the ones below.";
const IN_EXTENSION =
  "Approve it in your wallet's browser extension. Before you do, check there that the destination and the number of operations match the ones below.";
const IN_WINDOW =
  "Your wallet opens its own window. Before you approve there, check that the destination and the number of operations match the ones below.";
const ON_DEVICE =
  "Approve it on your Ledger. Before you do, check on the device that the destination and the number of operations match the ones below. If it shows a hash instead, compare it: it must start and end with the characters below.";
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
  [LEDGER_ID, ON_DEVICE],
]);

/** What to do in the wallet being asked to sign, by its kit id. */
export function signingGuidance(walletId: string | null): string {
  return (walletId !== null && GUIDANCE.get(walletId)) || ANY_WALLET;
}
