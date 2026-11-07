// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.

const VARIABLE = "NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID";

/** A Reown (WalletConnect) project id: 32 hexadecimal characters. */
const PROJECT_ID = /^[0-9a-f]{32}$/i;

/** All zeros: the placeholder test builds use, never a real project. */
const PLACEHOLDER = /^0+$/;

/**
 * Why a production deployment must not be built with this environment, or null when it may.
 *
 * Only Vercel's production deployment is held to it (`VERCEL_ENV === "production"`): preview
 * deployments, CI and local builds never set that value, so they build without WalletConnect and
 * the wallet picker says mobile wallets are unavailable. A production site without the project id
 * would ship with no path to any mobile wallet, LOBSTR included, and nothing else would notice.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function walletConnectBuildError(env) {
  if (env.VERCEL_ENV !== "production") return null;
  const id = (env[VARIABLE] ?? "").trim();
  if (id === "") {
    return `${VARIABLE} is not set. A production build needs the WalletConnect project id (from cloud.reown.com), or mobile wallets are unavailable. Set it for the Production environment and build again.`;
  }
  if (!PROJECT_ID.test(id) || PLACEHOLDER.test(id)) {
    return `${VARIABLE} is not a WalletConnect project id (32 hexadecimal characters, not the all-zero test placeholder). Set the real id for the Production environment and build again.`;
  }
  return null;
}
