/**
 * Checks a finished Vercel build output, in CI after `vercel build`. Plain JavaScript for Node.
 *
 *   node scripts/not-found-routing.mjs check-output <dir>
 *
 * On Vercel a 404 status comes only from the error route, which serves `/_not-found` once nothing
 * else matched. The rewrite that sends an unknown single path segment away from `[network]`
 * (config/network-ids.mjs) answers 404 only if its destination is a real miss there: a destination
 * that is a function, a prerender or a static file is served as it is, with status 200, and one
 * that a dynamic route matches renders that route instead. This fails, by name, when:
 *
 * 1. the build output does not hold exactly one rewrite, between the filesystem and the dynamic
 *    routes, for an unknown single segment, or that rewrite also takes a network;
 * 2. its destination exists in the output as a function, a prerender or a static file;
 * 3. a route of the rewrite phase (the dynamic routes) matches its destination;
 * 4. the error route does not serve the global 404 with status 404.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { NETWORK_IDS } from "../config/network-ids.mjs";

/** A segment no route or network will ever be named. */
const UNKNOWN_SEGMENT = "/lumenwipe-unknown-segment";

export class NotFoundRoutingError extends Error {}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new NotFoundRoutingError(message);
}

/**
 * @param {string} source
 * @returns {RegExp} the route's pattern, case-insensitive as Vercel matches it
 */
function routeRegex(source) {
  try {
    return new RegExp(source, "i");
  } catch {
    return fail(`a route pattern this check cannot read: ${source}`);
  }
}

/**
 * @param {Array<Record<string, any>>} routes
 * @param {string} handle
 * @returns {Array<Record<string, any>>} the routes after `{ handle }`, up to the next handle
 */
function phase(routes, handle) {
  const start = routes.findIndex((route) => route.handle === handle);
  if (start === -1) fail(`the build output has no "${handle}" phase`);
  const rest = routes.slice(start + 1);
  const end = rest.findIndex((route) => "handle" in route);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * @param {string} dest a route destination, such as `/a/b$rscsuff?segment=$1`
 * @returns {string} its path, without the query and the substituted captures
 */
function destinationPath(dest) {
  return dest.split("?")[0].replace(/\$[A-Za-z0-9_]+/g, "");
}

/**
 * @param {string} path
 * @returns {string[]} the files under .vercel/output that would serve `path` directly
 */
export function outputFilesFor(path) {
  const name = path.replace(/^\//, "");
  return [
    `functions/${name}.func`,
    `functions/${name}.rsc.func`,
    `functions/${name}.prerender-config.json`,
    `static/${name}`,
    `static/${name}.html`,
    `static/${name}.rsc`,
    `static/${name}/index.html`,
  ];
}

/**
 * @param {{ routes?: Array<Record<string, any>> }} config the Build Output API config
 * @param {(file: string) => boolean} exists whether a path relative to .vercel/output exists
 * @returns {string} the destination path of the unknown-segment rewrite
 */
export function verifyUnknownSegmentRoute(config, exists) {
  const routes = config.routes;
  if (!Array.isArray(routes)) fail("the build output config has no routes");

  const rewrites = phase(routes, "filesystem").filter(
    (route) => typeof route.dest === "string" && routeRegex(route.src).test(UNKNOWN_SEGMENT)
  );
  if (rewrites.length !== 1) {
    fail(`expected one afterFiles rewrite for an unknown segment, found ${rewrites.length}`);
  }
  const [rule] = rewrites;
  for (const network of NETWORK_IDS) {
    if (routeRegex(rule.src).test(`/${network}`))
      fail(`the unknown-segment rewrite takes /${network}`);
  }

  const path = destinationPath(rule.dest);
  const served = outputFilesFor(path).filter(exists);
  if (served.length > 0) {
    fail(
      `the unknown-segment rewrite goes to ${path}, which the output serves (${served.join(", ")})`
    );
  }

  for (const route of phase(routes, "rewrite")) {
    if (typeof route.src !== "string") continue;
    for (const candidate of [path, `${path}.rsc`]) {
      if (routeRegex(route.src).test(candidate)) {
        fail(`the unknown-segment rewrite goes to ${candidate}, which ${route.src} matches`);
      }
    }
  }

  const notFound = phase(routes, "error").find((route) => routeRegex(route.src).test(path));
  if (notFound?.dest !== "/_not-found" || notFound.status !== 404) {
    fail(`the error route does not serve /_not-found with status 404 for ${path}`);
  }
  return path;
}

if (basename(process.argv[1] ?? "") === "not-found-routing.mjs") {
  const [mode, outputDir] = process.argv.slice(2);
  try {
    if (mode !== "check-output" || !outputDir) fail("usage: check-output <build output directory>");
    const config = JSON.parse(readFileSync(join(outputDir, "config.json"), "utf8"));
    const path = verifyUnknownSegmentRoute(config, (file) => existsSync(join(outputDir, file)));
    console.log(`not-found routing: an unknown segment goes to ${path}, a miss answered with 404`);
  } catch (error) {
    if (!(error instanceof NotFoundRoutingError)) throw error;
    console.error(`not-found routing: ${error.message}`);
    process.exit(1);
  }
}
