import { feature, STATUS_LABEL, type FeatureId } from "@/lib/site/status";

export const REPO_URL = "https://github.com/LumenWipe/lumenwipe";
export const VERIFY_SOURCE_URL = `${REPO_URL}/blob/main/apps/web/lib/stellar/verify.ts`;

/** Where the key lives. Enforced by the signing flow: no request carries a secret key. */
export const KEY_STATEMENT =
  "Your secret key never reaches a LumenWipe server, and LumenWipe does not store or log it: you sign in your browser, through your wallet or a key held in memory for this session only.";

/** What the API does and what the browser checks (apps/web/lib/stellar/verify.ts). */
export const CHECK_STATEMENT =
  "The LumenWipe API reads your account and builds each unsigned transaction. Before you sign, your browser decodes it and checks its operations and destination against what you entered; if they do not match, it stops before asking you to sign.";

export const SERVER_KEYS_INTRO =
  "Two keys sign on the server, and neither can sign for your account.";

export interface ServerKey {
  feature: FeatureId;
  name: string;
  statement: string;
}

/** Enforced by apps/api/src/mediator/mediator-signing.service.ts and verify.ts (relay), and by
 *  apps/api/src/fee-bump/fee-bump.controller.ts (fee sponsor). */
export const SERVER_KEYS: readonly ServerKey[] = [
  {
    feature: "exchange-close",
    name: "Relay account key",
    statement:
      "In an exchange close, it co-signs only a two-operation transaction: your account's merge into the relay account and an XLM payment from it in the same transaction. Before you sign, your browser checks that this payment goes to the exchange address you typed.",
  },
  {
    feature: "sponsored-fees",
    name: "Fee-sponsor key",
    statement:
      "When a fee is sponsored, it signs only the fee-bump envelope that pays the network fee for a transaction you already signed, and cannot change that transaction.",
  },
];

/** "Testnet only today." for a key whose feature is not live on mainnet, else "". */
export function serverKeyScope(key: ServerKey): string {
  const status = feature(key.feature).status;
  return status === "live" ? "" : `${STATUS_LABEL[status]} today.`;
}
