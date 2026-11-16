import { SITE_LOCALE } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import { feature, STATUS_LABEL, type FeatureId } from "@/lib/site/status";

export const REPO_URL = "https://github.com/LumenWipe/lumenwipe";
export const VERIFY_SOURCE_URL = `${REPO_URL}/blob/main/apps/web/lib/stellar/verify.ts`;

const COPY = SITE[SITE_LOCALE].trust;

/** Where the key lives. Enforced by the signing flow: no request carries a secret key. */
export const KEY_STATEMENT = COPY.key;

/** What the API does and what the browser checks (apps/web/lib/stellar/verify.ts). */
export const CHECK_STATEMENT = COPY.check;

export const SERVER_KEYS_INTRO = COPY.serverKeysIntro;

export interface ServerKey {
  feature: FeatureId;
  name: string;
  statement: string;
}

/** Enforced by apps/api/src/mediator/mediator-signing.service.ts and verify.ts (relay), and by
 *  apps/api/src/fee-bump/fee-bump.controller.ts (fee sponsor). */
export const SERVER_KEYS: readonly ServerKey[] = (
  ["exchange-close", "sponsored-fees"] as const
).map((id) => ({ feature: id, ...COPY.serverKeys[id] }));

/** "Testnet only today." for a key whose feature is not live on mainnet, else "". */
export function serverKeyScope(key: ServerKey): string {
  const status = feature(key.feature).status;
  return status === "live" ? "" : COPY.scope(STATUS_LABEL[status]);
}
