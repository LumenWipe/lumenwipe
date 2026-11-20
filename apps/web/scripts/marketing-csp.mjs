/**
 * Runs after `next build` (the `build` script), on Vercel and in CI. Plain JavaScript for Node.
 *
 *   node scripts/marketing-csp.mjs                    check, inject, then check what was written
 *   node scripts/marketing-csp.mjs check              check an already injected build, write nothing
 *   node scripts/marketing-csp.mjs check-output <dir> check a finished Vercel build output
 *
 * 1. Every route under app/(marketing) and app/(marketing-es) must be prerendered, as Next's own
 *    prerender manifest records it: a dynamic marketing route fails the build, by name.
 * 2. Each prerendered marketing page gets a Content-Security-Policy whose script-src lists the
 *    SHA-256 of every inline script in that page's HTML (config/marketing-csp.mjs). The proxy
 *    skips these paths, so this is their only policy. It is written where the deployment reads
 *    it: on Vercel, Next's build adapter has already written the Build Output API config
 *    (.next/output/config.json) inside `next build`, so the policy becomes a header route there;
 *    for `next start` it is an entry in .next/routes-manifest.json.
 * 3. It fails closed: a page with no policy, a policy whose hashes miss one of the page's inline
 *    scripts or that allows framing or an unsafe source, a script loaded from an origin the
 *    policy does not allow, a build adapter with no output config, a nonce path the proxy does
 *    not cover, or a file not shaped as expected exits 1 and names the page.
 * 4. In a Build Output config, `/` must carry the discovery Link header (config/discovery-links.mjs)
 *    from a header route, and no other marketing or nonce path any Link header.
 * 5. In a Build Output config, the apex host must get the 308 to www (config/apex-redirect.mjs)
 *    from one route before the first `handle`, under a header route that sets the app's HSTS.
 * 6. In a Build Output config, the signing routes must end with the Permissions-Policy that opens
 *    WebUSB to self, and every other page, nonce path and API path with the one that refuses it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { APEX_REDIRECT, CANONICAL_ORIGIN } from "../config/apex-redirect.mjs";
import { HOMEPAGE_LINK } from "../config/discovery-links.mjs";
import { marketingPolicy } from "../config/marketing-csp.mjs";
import { SECURITY_HEADERS, SIGNING_PERMISSIONS_POLICY } from "../config/security-headers.mjs";

// The English and Spanish marketing route groups (docs/contributing/localization.mdx).
const GROUPS = ["/(marketing)/", "/(marketing-es)/"];
const CSP = "Content-Security-Policy";
const LINK = "Link";
const HSTS = "Strict-Transport-Security";
const PERMISSIONS = "Permissions-Policy";
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
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
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

/** @param {string} src @returns {boolean} whether src is a same-origin path. */
function allowedScriptSource(src) {
  return src.startsWith("/") && !src.startsWith("//");
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
  const entries = Object.entries(appPaths).filter(([appPath]) =>
    GROUPS.some((group) => appPath.startsWith(group))
  );
  for (const group of GROUPS) {
    if (!entries.some(([appPath]) => appPath.startsWith(group)))
      fail(`app-path-routes-manifest.json lists no ${group.slice(1, -1)} route`);
  }

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
  return marketingPolicy({ hashes: inline.map(scriptHash) });
}

/**
 * Appends one CSP entry per page to the routes manifest, replacing any this step wrote before.
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
    assertPlainPath(path);
    manifest.headers.push({
      source: path,
      regex: exactPathRegex(path),
      headers: [{ key: CSP, value: policy }],
    });
  }
}

/** @param {unknown} config */
function assertOutputConfig(config) {
  const routes = /** @type {{ routes?: unknown }} */ (config)?.routes;
  if (!Array.isArray(routes) || !routes.every((route) => route && typeof route === "object")) {
    fail("the Build Output config has no routes array");
  }
}

/**
 * Prepends one header route per page to a Build Output API config, replacing any this step wrote
 * before. Routes before the first `handle` apply their headers to every matching response.
 *
 * @param {{ routes: Array<Record<string, any>> }} config
 * @param {Map<string, string>} policies page path to policy
 */
export function injectRoutes(config, policies) {
  assertOutputConfig(config);
  const ours = new Set([...policies.keys()].map(exactPathRegex));
  const kept = config.routes.filter((route) => !(ours.has(route.src) && cspValues(route).length));
  const added = [...policies].map(([path, policy]) => {
    assertPlainPath(path);
    return { src: exactPathRegex(path), headers: { [CSP]: policy }, continue: true };
  });
  config.routes = [...added, ...kept];
}

/** @param {string} path */
function assertPlainPath(path) {
  if (!PLAIN_PATH.test(path)) fail(`${path} is not a plain path`);
}

/**
 * @param {Record<string, any>} route
 * @param {string} name
 * @returns {string[]} the values of one header a config route sets.
 */
function headerValues(route, name) {
  return Object.entries(route.headers ?? {})
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => String(value));
}

/** @param {Record<string, any>} route @returns {string[]} the CSP values a config route sets. */
function cspValues(route) {
  return headerValues(route, CSP);
}

/**
 * @param {string} source
 * @param {string} where
 * @param {string} [flags] "i" for Build Output routes, which Vercel matches case-insensitively
 * @returns {RegExp}
 */
function routeRegex(source, where, flags = "") {
  try {
    return new RegExp(source, flags);
  } catch {
    return fail(`${where} has a route pattern this check cannot read: ${source}`);
  }
}

/**
 * Fails unless each page is matched by exactly one policy whose script-src hashes cover every
 * inline script in its HTML, allows no unsafe source, and forbids framing.
 *
 * @param {Array<{ regex: RegExp, policies: string[] }>} entries every header rule, with the CSP
 *   values it sets
 * @param {Map<string, string>} htmlByPath page path to the HTML it serves
 */
function verifyCoverage(entries, htmlByPath) {
  for (const [path, html] of htmlByPath) {
    const policies = entries.filter((e) => e.regex.test(path)).flatMap((e) => e.policies);
    if (policies.length !== 1)
      fail(`${path} has ${policies.length} CSP header entries, expected 1`);
    const directives = policies[0].split(";").map((d) => d.trim());
    const scriptSrc = directives.find((d) => d.startsWith("script-src ")) ?? "";
    if (/'unsafe-(inline|eval)'/.test(scriptSrc)) fail(`${path} allows unsafe script sources`);
    if (!directives.includes("frame-ancestors 'none'"))
      fail(`${path} has no frame-ancestors 'none'`);
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

/**
 * @param {unknown} manifest routes-manifest.json
 * @param {Map<string, string>} htmlByPath page path to its prerendered HTML
 */
export function verifyPolicies(manifest, htmlByPath) {
  assertRoutesManifest(manifest);
  const entries =
    /** @type {{ headers: Array<{ regex: string, headers: Array<{ key: string, value: string }> }> }} */ (
      manifest
    ).headers.map((entry) => ({
      regex: routeRegex(entry.regex, "routes-manifest.json"),
      policies: entry.headers
        .filter((h) => h.key.toLowerCase() === CSP.toLowerCase())
        .map((h) => h.value),
    }));
  verifyCoverage(entries, htmlByPath);
}

/**
 * Paths that must keep the proxy's nonce policy: the network and sign-in routes and the 404
 * shapes, the same paths as the golden nonce fixture. The deployment must run the proxy on each
 * and give none a marketing policy.
 */
export const NONCE_PATHS = [
  "/mainnet",
  "/testnet/analyze",
  "/mainnet/receipt/abc",
  "/cosign",
  "/api-keys",
  "/x/y/z",
  "/blog/nope",
  "/es/nope",
  "/es/blog/nope",
];

/**
 * Verifies a Build Output API config as Vercel serves it: each page's policy comes from a header
 * route before the first `handle` (later phases do not add headers to a prerendered page), and
 * every nonce path is matched by the proxy's route and by no CSP route at all.
 *
 * @param {unknown} config .vercel/output/config.json or .next/output/config.json
 * @param {Map<string, string>} htmlByPath page path to its prerendered HTML
 */
export function verifyRoutes(config, htmlByPath) {
  assertOutputConfig(config);
  const routes = /** @type {{ routes: Array<Record<string, any>> }} */ (config).routes;
  const firstHandle = routes.findIndex((route) => "handle" in route);
  const headerRoutes = (firstHandle === -1 ? routes : routes.slice(0, firstHandle)).filter(
    (route) => typeof route.src === "string" && route.headers
  );
  verifyCoverage(
    headerRoutes.map((route) => ({
      regex: routeRegex(route.src, "the Build Output config", "i"),
      policies: cspValues(route),
    })),
    htmlByPath
  );
  const cspRoutes = routes.filter(
    (route) => typeof route.src === "string" && cspValues(route).length
  );
  const proxyRoutes = routes.filter(
    (route) => typeof route.src === "string" && typeof route.middlewarePath === "string"
  );
  verifyHomepageLink(routes, headerRoutes, [...htmlByPath.keys(), ...NONCE_PATHS]);
  verifyApexRedirect(routes, firstHandle, [...htmlByPath.keys(), ...NONCE_PATHS, "/api/v1/x"]);
  verifyWebUsb(headerRoutes, [...htmlByPath.keys(), ...NONCE_PATHS, ...WEBUSB_PATHS, "/api/v1/x"]);
  for (const path of NONCE_PATHS) {
    if (cspRoutes.some((route) => routeRegex(route.src, "the Build Output config", "i").test(path)))
      fail(`${path} is matched by a marketing CSP route`);
    if (
      !proxyRoutes.some((route) => routeRegex(route.src, "the Build Output config", "i").test(path))
    )
      fail(`${path} is not matched by the proxy's route, so it would have no nonce policy`);
  }
}

/** Paths of the routes that sign, which alone get WebUSB (config/security-headers.mjs). */
export const WEBUSB_PATHS = [
  "/mainnet",
  "/testnet",
  "/testnet/analyze",
  "/mainnet/execute",
  "/testnet/allowances",
  "/mainnet/receipt/abc",
  "/cosign",
];

/**
 * Fails unless each path ends with exactly the Permissions-Policy of its class: the signing one on
 * `WEBUSB_PATHS`, the app's own everywhere else. A later header route replaces an earlier one's
 * value of the same header, so the last match before the first `handle` is what is served.
 *
 * @param {Array<Record<string, any>>} headerRoutes the header routes before the first `handle`
 * @param {string[]} paths the paths to check
 */
function verifyWebUsb(headerRoutes, paths) {
  const base = SECURITY_HEADERS.find((h) => h.key === PERMISSIONS)?.value;
  for (const path of paths) {
    const served = continueHeaderValues(headerRoutes, path, PERMISSIONS).slice(-1);
    const expected = WEBUSB_PATHS.includes(path) ? SIGNING_PERMISSIONS_POLICY : base;
    if (served.length !== 1 || served[0] !== expected) {
      fail(`${path} is served Permissions-Policy ${JSON.stringify(served)}, expected ${expected}`);
    }
  }
}

/**
 * Fails unless `/` gets exactly the discovery Link header from a route before the first `handle`,
 * and no other page or nonce path gets a Link header from any route.
 *
 * @param {Array<Record<string, any>>} routes every config route
 * @param {Array<Record<string, any>>} headerRoutes the header routes before the first `handle`
 * @param {string[]} paths the marketing and nonce paths
 */
function verifyHomepageLink(routes, headerRoutes, paths) {
  const linksFor = (/** @type {Array<Record<string, any>>} */ list, /** @type {string} */ path) =>
    list
      .filter(
        (route) =>
          typeof route.src === "string" &&
          routeRegex(route.src, "the Build Output config", "i").test(path)
      )
      .flatMap((route) => headerValues(route, LINK));
  const home = linksFor(headerRoutes, "/");
  if (home.length !== 1 || home[0] !== HOMEPAGE_LINK) {
    fail(`/ has Link header ${JSON.stringify(home)}, expected exactly the discovery links`);
  }
  for (const path of paths) {
    if (path !== "/" && linksFor(routes, path).length > 0) fail(`${path} has a Link header route`);
  }
}

/**
 * Fails unless exactly one route before the first `handle` matches on the host, and it is the
 * apex redirect: exactly the host value Next was given (Vercel's router reads it as an anchored
 * regex, so an unescaped dot would also match look-alike hosts), a final 308 to the same path on
 * www for every path, and the app's HSTS set on each path by a header route ahead of it.
 *
 * @param {Array<Record<string, any>>} routes every config route
 * @param {number} firstHandle index of the first `handle` route, -1 for none
 * @param {string[]} paths the paths to check
 */
function verifyApexRedirect(routes, firstHandle, paths) {
  const end = firstHandle === -1 ? routes.length : firstHandle;
  const hostRoutes = routes
    .map((route, index) => ({ route, index }))
    .filter(({ route }) => (route.has ?? []).some((/** @type {any} */ h) => h?.type === "host"));
  if (hostRoutes.length !== 1 || hostRoutes[0].index >= end) {
    fail(`${hostRoutes.length} host-matched routes, expected the apex redirect before handle`);
  }
  const { route, index } = hostRoutes[0];
  const expected = JSON.stringify(APEX_REDIRECT.has);
  if (JSON.stringify(route.has) !== expected) {
    fail(`the apex redirect matches hosts ${JSON.stringify(route.has)}, expected ${expected}`);
  }
  if (route.status !== 308 || route.continue || typeof route.src !== "string") {
    fail(`the apex redirect is not a final 308: ${JSON.stringify(route)}`);
  }
  const src = routeRegex(route.src, "the Build Output config", "i");
  const location = headerValues(route, "Location");
  for (const path of paths) {
    const target = src.test(path) && location.length === 1 && path.replace(src, location[0]);
    if (target !== `${CANONICAL_ORIGIN}${path}`) {
      fail(`the apex redirect sends ${path} to ${target || "nowhere"}`);
    }
    const hsts = continueHeaderValues(routes.slice(0, index), path, HSTS);
    if (hsts.length !== 1 || hsts[0] !== SECURITY_HEADERS.find((h) => h.key === HSTS)?.value) {
      fail(`the apex redirect for ${path} carries HSTS ${JSON.stringify(hsts)}`);
    }
  }
}

/**
 * @param {Array<Record<string, any>>} routes
 * @param {string} path
 * @param {string} name
 * @returns {string[]} the values of one header the unconditional `continue` routes matching path
 *   set.
 */
function continueHeaderValues(routes, path, name) {
  return routes
    .filter(
      (route) =>
        route.continue === true &&
        typeof route.src === "string" &&
        !route.has &&
        !route.missing &&
        routeRegex(route.src, "the Build Output config", "i").test(path)
    )
    .flatMap((route) => headerValues(route, name));
}

/** @param {string} path @returns {string} the file name a page is written under, without extension. */
function pageFile(path) {
  return path === "/" ? "/index" : path;
}

/** @param {string} file @returns {string | null} the file's text, or null when there is none. */
function readIfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} file @param {string} text @returns {any} */
function parseJson(file, text) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${file} is not valid JSON`);
  }
}

/** @param {string} file @returns {any} the parsed file, or null when there is none. */
function readJsonIfPresent(file) {
  const text = readIfPresent(file);
  return text === null ? null : parseJson(file, text);
}

/** @param {string} file @returns {any} */
function readJson(file) {
  const text = readIfPresent(file);
  if (text === null) fail(`${file} is missing: run next build first`);
  return parseJson(file, text);
}

/**
 * @param {string[]} pages
 * @param {(path: string) => string} fileOf
 * @returns {Map<string, string>}
 */
function readPages(pages, fileOf) {
  return new Map(
    pages.map((path) => {
      const file = fileOf(path);
      const html = readIfPresent(file);
      if (html === null) fail(`${path} is prerendered but ${file} is missing`);
      return [path, html];
    })
  );
}

/** @param {string} dir the .next directory @returns {string[]} */
function marketingPages(dir) {
  return prerenderedMarketingPages(
    readJson(join(dir, "app-path-routes-manifest.json")),
    readJson(join(dir, "prerender-manifest.json"))
  );
}

/** @param {string} outputDir a Build Output API directory */
function outputPageFile(outputDir) {
  return (/** @type {string} */ path) =>
    join(outputDir, "functions", `${pageFile(path)}.prerender-fallback.html`);
}

/**
 * Writes (when `write`) and verifies each page's policy where the deployment reads it. Under a
 * build adapter, as on Vercel, `next build` has already turned the routes manifest into
 * `.next/output/config.json`, so the policy goes there and the HTML is read from that output.
 * Otherwise (`next start`) it goes into the routes manifest.
 *
 * @param {string} dir the .next directory
 * @param {boolean} write
 * @param {Record<string, string | undefined>} env
 */
export function run(dir, write, env = process.env) {
  const pages = marketingPages(dir);
  const outputDir = join(dir, "output");
  const configFile = join(outputDir, "config.json");
  const config = readJsonIfPresent(configFile);
  if (config !== null) {
    const htmlByPath = readPages(pages, outputPageFile(outputDir));
    if (write) {
      injectRoutes(
        config,
        new Map([...htmlByPath].map(([path, html]) => [path, policyForPage(html, path)]))
      );
      writeFileSync(configFile, JSON.stringify(config));
    }
    verifyRoutes(readJson(configFile), htmlByPath);
    return pages;
  }
  if (env.NEXT_ADAPTER_PATH) {
    fail(`a build adapter ran but ${configFile} is missing, so the policy has nowhere to go`);
  }
  const htmlByPath = readPages(pages, (path) =>
    join(dir, "server", "app", `${pageFile(path)}.html`)
  );
  const manifestFile = join(dir, "routes-manifest.json");
  if (write) {
    const manifest = readJson(manifestFile);
    injectPolicies(
      manifest,
      new Map([...htmlByPath].map(([path, html]) => [path, policyForPage(html, path)]))
    );
    writeFileSync(manifestFile, JSON.stringify(manifest));
  }
  verifyPolicies(readJson(manifestFile), htmlByPath);
  return pages;
}

/**
 * Verifies a finished Vercel build output against the pages Next prerendered.
 *
 * @param {string} dir the .next directory
 * @param {string} outputDir .vercel/output
 */
export function checkOutput(dir, outputDir) {
  const pages = marketingPages(dir);
  verifyRoutes(
    readJson(join(outputDir, "config.json")),
    readPages(pages, outputPageFile(outputDir))
  );
  return pages;
}

// Run from apps/web, as the build script does. No import.meta: Playwright loads this file too.
if (basename(process.argv[1] ?? "") === "marketing-csp.mjs") {
  const [mode, outputDir] = process.argv.slice(2);
  const dir = join(process.cwd(), ".next");
  try {
    if (mode === "check-output") {
      if (!outputDir) fail("check-output needs the build output directory");
      const pages = checkOutput(dir, outputDir);
      console.log(
        `marketing CSP: ${pages.length} pages in ${outputDir}, each with its hash policy`
      );
    } else {
      const pages = run(dir, mode !== "check");
      console.log(`marketing CSP: ${pages.length} prerendered pages, each with its hash policy`);
    }
  } catch (error) {
    if (!(error instanceof MarketingCspError)) throw error;
    console.error(`marketing CSP: ${error.message}`);
    process.exit(1);
  }
}
