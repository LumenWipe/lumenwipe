/**
 * Runs after `next build` (the `build` script), on Vercel and in CI. Plain JavaScript for Node.
 *
 *   node scripts/marketing-csp.mjs          check, inject, then check what was written
 *   node scripts/marketing-csp.mjs check    check an already injected build, write nothing
 *
 * 1. Every route under app/(marketing) must be prerendered, as Next's own prerender manifest
 *    records it: a dynamic marketing route fails the build, by name.
 * 2. Each prerendered marketing page gets a Content-Security-Policy header entry in
 *    .next/routes-manifest.json, which both `next start` and Vercel's builder read after the
 *    build: script-src lists the SHA-256 of every inline script in that page's HTML
 *    (config/marketing-csp.mjs). The proxy skips these paths, so this entry is their only policy.
 * 3. It fails closed: a page with no entry, an entry whose hashes miss one of the page's inline
 *    scripts, a script loaded from an origin the policy does not allow, or a manifest not shaped
 *    as expected exits 1 and names the page.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { marketingPolicy, UMAMI_SCRIPT_ORIGIN } from "../config/marketing-csp.mjs";

const GROUP = "/(marketing)/";
const CSP = "Content-Security-Policy";
const SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
// Prerendered paths come from our own route names; anything else would be read as a pattern by
// the manifest's `source` matcher.
const PLAIN_PATH = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;

export class MarketingCspError extends Error {}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new MarketingCspError(message);
}

/**
 * @param {string} html
 * @returns {{ inline: string[], external: string[] }} the bodies of the inline scripts the
 *   browser runs (data blocks such as JSON-LD excluded), and the src of every external script.
 */
export function pageScripts(html) {
  const inline = [];
  const external = [];
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /\ssrc\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const type = (/\stype\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "").toLowerCase();
    if (!SCRIPT_TYPES.has(type)) continue;
    if (src !== undefined) external.push(src);
    else inline.push(body);
  }
  return { inline, external };
}

/** @param {string} body @returns {string} */
export function scriptHash(body) {
  return createHash("sha256").update(body, "utf8").digest("base64");
}

/** @param {string} src @returns {boolean} whether src is same-origin or Umami's script. */
function allowedScriptSource(src) {
  if (src.startsWith("/") && !src.startsWith("//")) return true;
  try {
    return new URL(src).origin === UMAMI_SCRIPT_ORIGIN;
  } catch {
    return false;
  }
}

/** @param {string} path @returns {string} the exact-path regex Vercel's router matches. */
export function exactPathRegex(path) {
  return path === "/" ? "^/$" : `^${path}(?:/)?$`;
}

/**
 * The marketing routes as Next's build recorded them, each checked to be prerendered.
 *
 * @param {Record<string, string>} appPaths app-path-routes-manifest.json
 * @param {{ routes: Record<string, { srcRoute?: string | null }>, dynamicRoutes: Record<string, { fallback?: unknown }> }} prerender
 *   prerender-manifest.json
 * @returns {string[]} every prerendered marketing page path, sorted.
 */
export function prerenderedMarketingPages(appPaths, prerender) {
  if (
    !prerender ||
    typeof prerender.routes !== "object" ||
    typeof prerender.dynamicRoutes !== "object"
  ) {
    fail("prerender-manifest.json has no routes or dynamicRoutes map");
  }
  const entries = Object.entries(appPaths).filter(([appPath]) => appPath.startsWith(GROUP));
  if (entries.length === 0) fail("app-path-routes-manifest.json lists no (marketing) route");

  const dynamic = [];
  const pages = [];
  for (const [appPath, route] of entries) {
    const children = Object.entries(prerender.routes)
      .filter(([, meta]) => meta?.srcRoute === route)
      .map(([path]) => path);
    const isStatic = route.includes("[")
      ? prerender.dynamicRoutes[route]?.fallback === false && children.length > 0
      : route in prerender.routes;
    if (!isStatic) {
      dynamic.push(route);
      continue;
    }
    if (appPath.endsWith("/page")) pages.push(...(route.includes("[") ? children : [route]));
  }
  if (dynamic.length > 0) {
    fail(`marketing routes not prerendered (dynamic): ${dynamic.sort().join(", ")}`);
  }
  return [...new Set(pages)].sort();
}

/** @param {unknown} manifest */
function assertRoutesManifest(manifest) {
  const headers = /** @type {{ headers?: unknown }} */ (manifest)?.headers;
  if (!Array.isArray(headers)) fail("routes-manifest.json has no headers array");
  for (const entry of headers) {
    if (
      typeof entry?.source !== "string" ||
      typeof entry?.regex !== "string" ||
      !Array.isArray(entry?.headers) ||
      !entry.headers.every((h) => typeof h?.key === "string" && typeof h?.value === "string")
    ) {
      fail(
        `routes-manifest.json has a header entry of an unexpected shape: ${JSON.stringify(entry)}`
      );
    }
  }
}

/**
 * @param {string} html
 * @param {string} path
 * @returns {string} the policy the page needs.
 */
export function policyForPage(html, path) {
  const { inline, external } = pageScripts(html);
  const refused = external.filter((src) => !allowedScriptSource(src));
  if (refused.length > 0)
    fail(`${path} loads a script the policy cannot allow: ${refused.join(", ")}`);
  return marketingPolicy({
    hashes: inline.map(scriptHash),
    umami: external.some((src) => !src.startsWith("/")),
  });
}

/**
 * Appends one CSP entry per page, replacing any this step wrote before.
 *
 * @param {{ headers: Array<{ source: string, regex: string, headers: Array<{ key: string, value: string }> }> }} manifest
 * @param {Map<string, string>} policies page path to policy
 */
export function injectPolicies(manifest, policies) {
  assertRoutesManifest(manifest);
  manifest.headers = manifest.headers.filter(
    (entry) => !(policies.has(entry.source) && entry.headers.some((h) => h.key === CSP))
  );
  for (const [path, policy] of policies) {
    if (!PLAIN_PATH.test(path)) fail(`${path} is not a plain path`);
    manifest.headers.push({
      source: path,
      regex: exactPathRegex(path),
      headers: [{ key: CSP, value: policy }],
    });
  }
}

/**
 * Fails unless each page is matched by exactly one CSP entry whose script-src hashes cover every
 * inline script in its HTML.
 *
 * @param {unknown} manifest routes-manifest.json
 * @param {Map<string, string>} htmlByPath page path to its prerendered HTML
 */
export function verifyPolicies(manifest, htmlByPath) {
  assertRoutesManifest(manifest);
  const entries =
    /** @type {{ headers: Array<{ regex: string, headers: Array<{ key: string, value: string }> }> }} */ (
      manifest
    ).headers;
  for (const [path, html] of htmlByPath) {
    const policies = entries
      .filter((entry) => new RegExp(entry.regex).test(path))
      .flatMap((entry) => entry.headers.filter((h) => h.key.toLowerCase() === CSP.toLowerCase()))
      .map((h) => h.value);
    if (policies.length !== 1)
      fail(`${path} has ${policies.length} CSP header entries, expected 1`);
    const scriptSrc = policies[0].split("; ").find((d) => d.startsWith("script-src ")) ?? "";
    if (/'unsafe-(inline|eval)'/.test(scriptSrc)) fail(`${path} allows unsafe script sources`);
    const allowed = new Set(scriptSrc.split(" ").slice(1));
    const missing = pageScripts(html)
      .inline.map(scriptHash)
      .filter((hash) => !allowed.has(`'sha256-${hash}'`));
    if (missing.length > 0) {
      fail(
        `${path} runs ${missing.length} inline script(s) its CSP does not hash: ${missing.join(", ")}`
      );
    }
  }
}

/** @param {string} dir .next @param {string} path @returns {string} */
function htmlFile(dir, path) {
  return join(dir, "server", "app", `${path === "/" ? "/index" : path}.html`);
}

/** @param {string} file @returns {any} */
function readJson(file) {
  if (!existsSync(file)) fail(`${file} is missing: run next build first`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** @param {string} dir the .next directory @param {boolean} write */
export function run(dir, write) {
  const pages = prerenderedMarketingPages(
    readJson(join(dir, "app-path-routes-manifest.json")),
    readJson(join(dir, "prerender-manifest.json"))
  );
  const htmlByPath = new Map(
    pages.map((path) => {
      const file = htmlFile(dir, path);
      if (!existsSync(file)) fail(`${path} is prerendered but ${file} is missing`);
      return [path, readFileSync(file, "utf8")];
    })
  );
  const manifestFile = join(dir, "routes-manifest.json");
  const manifest = readJson(manifestFile);
  if (write) {
    injectPolicies(
      manifest,
      new Map([...htmlByPath].map(([path, html]) => [path, policyForPage(html, path)]))
    );
    writeFileSync(manifestFile, JSON.stringify(manifest));
  }
  verifyPolicies(readJson(manifestFile), htmlByPath);
  return pages;
}

// Run from apps/web, as the build script does. No import.meta: Playwright loads this file too.
if (basename(process.argv[1] ?? "") === "marketing-csp.mjs") {
  const mode = process.argv[2];
  try {
    const pages = run(join(process.cwd(), ".next"), mode !== "check");
    console.log(`marketing CSP: ${pages.length} prerendered pages, each with its hash policy`);
  } catch (error) {
    if (!(error instanceof MarketingCspError)) throw error;
    console.error(`marketing CSP: ${error.message}`);
    process.exit(1);
  }
}
