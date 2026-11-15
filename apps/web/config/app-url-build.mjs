// Read by next.config.mjs, so plain JavaScript: the config is loaded before anything is compiled.

const VARIABLE = "NEXT_PUBLIC_APP_URL";

/**
 * Why a production deployment must not be built with this environment, or null when it may.
 *
 * Every canonical URL, share image, sitemap entry and structured-data block is absolute and
 * derived from this variable, so a production build without it would point them all at a
 * fallback host. Only Vercel's production deployment is held to it (`VERCEL_ENV === "production"`),
 * like the WalletConnect check.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function appUrlBuildError(env) {
  if (env.VERCEL_ENV !== "production") return null;
  const value = (env[VARIABLE] ?? "").trim();
  if (value === "") {
    return `${VARIABLE} is not set. A production build needs the site's public origin (for example https://lumenwipe.com) for canonical URLs, share images, the sitemap and structured data. Set it for the Production environment and build again.`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  const bareOrigin =
    url !== null &&
    url.protocol === "https:" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === "";
  if (!bareOrigin) {
    return `${VARIABLE} must be an https origin with no path, query or fragment (for example https://lumenwipe.com), not "${value}". Set it for the Production environment and build again.`;
  }
  return null;
}
