import { SITE_LOCALE, type Locale } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import { feature, statusLabels, type FeatureId } from "@/lib/site/status";

export const REPO_URL = "https://github.com/LumenWipe/lumenwipe";
export const VERIFY_SOURCE_URL = `${REPO_URL}/blob/main/apps/web/lib/stellar/verify.ts`;

/** The trust statements as a reader of `locale` reads them. */
export function trustStatements(locale: Locale) {
  const copy = SITE[locale].trust;
  return { key: copy.key, check: copy.check, serverKeysIntro: copy.serverKeysIntro };
}

const STATEMENTS = trustStatements(SITE_LOCALE);

/** Where the key lives. Enforced by the signing flow: no request carries a secret key. */
export const KEY_STATEMENT = STATEMENTS.key;

/** What the API does and what the browser checks (apps/web/lib/stellar/verify.ts). */
export const CHECK_STATEMENT = STATEMENTS.check;

export const SERVER_KEYS_INTRO = STATEMENTS.serverKeysIntro;

export interface ServerKey {
  feature: FeatureId;
  name: string;
  statement: string;
}

/** Enforced by apps/api/src/mediator/mediator-signing.service.ts and verify.ts (relay), and by
 *  apps/api/src/fee-bump/fee-bump.controller.ts (fee sponsor). */
export function serverKeys(locale: Locale): readonly ServerKey[] {
  return (["exchange-close", "sponsored-fees"] as const).map((id) => ({
    feature: id,
    ...SITE[locale].trust.serverKeys[id],
  }));
}

export const SERVER_KEYS: readonly ServerKey[] = serverKeys(SITE_LOCALE);

/** "Testnet only today." for a feature that is not live on mainnet, else "". */
export function featureScope(id: FeatureId, locale: Locale = SITE_LOCALE): string {
  const status = feature(id).status;
  return status === "live" ? "" : SITE[locale].trust.scope(statusLabels(locale)[status]);
}

/** "Testnet only today." for a key whose feature is not live on mainnet, else "". */
export function serverKeyScope(key: ServerKey, locale: Locale = SITE_LOCALE): string {
  return featureScope(key.feature, locale);
}

/** Where security reports go, as SECURITY.md and /.well-known/security.txt publish it. */
export const SECURITY_EMAIL = "security@lumenwipe.com";
export const SECURITY_POLICY_URL = `${REPO_URL}/blob/main/SECURITY.md`;
export const SECURITY_TXT_PATH = "/.well-known/security.txt";
