/** Where a build without `NEXT_PUBLIC_APP_URL` points: local, CI and preview builds only, since
 *  a production build refuses to run without it (config/app-url-build.mjs). */
const FALLBACK_ORIGIN = "https://www.lumenwipe.com";

/** The site's origin, from `NEXT_PUBLIC_APP_URL`, never empty. */
export function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return FALLBACK_ORIGIN;
  try {
    return new URL(configured).origin;
  } catch {
    return FALLBACK_ORIGIN;
  }
}

/** The absolute URL of a path on this site. */
export function siteUrl(path: string): string {
  return new URL(path, siteOrigin()).toString();
}
