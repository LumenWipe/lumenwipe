import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOMEPAGE_LINK } from "@/config/discovery-links.mjs";
import { marketingPolicy } from "@/config/marketing-csp.mjs";
import {
  checkOutput,
  exactPathRegex,
  injectPolicies,
  MarketingCspError,
  NONCE_PATHS,
  pageScripts,
  prerenderedMarketingPages,
  run,
  scriptHash,
} from "@/scripts/marketing-csp.mjs";

const NEXT_INIT = "(self.__next_f=self.__next_f||[]).push([0])";
const page = (flight: string, extra = "") =>
  `<!DOCTYPE html><html><head><script src="/_next/static/chunks/main.js" async=""></script>` +
  `<script type="application/ld+json">{"@type":"WebSite"}</script>${extra}</head><body>` +
  `<script>${NEXT_INIT}</script><script>self.__next_f.push([1,"${flight}"])</script></body></html>`;

const APP_PATHS = {
  "/(marketing)/page": "/",
  "/(marketing)/faq/page": "/faq",
  "/(marketing)/blog/[slug]/page": "/blog/[slug]",
  "/(marketing)/blog/[slug]/share.png/route": "/blog/[slug]/share.png",
  "/(app)/[network]/page": "/[network]",
};
const PRERENDER = {
  version: 4,
  routes: {
    "/": { srcRoute: "/" },
    "/faq": { srcRoute: "/faq" },
    "/blog/a-post": { srcRoute: "/blog/[slug]" },
    "/blog/a-post/share.png": { srcRoute: "/blog/[slug]/share.png" },
  },
  dynamicRoutes: {
    "/blog/[slug]": { fallback: false },
    "/blog/[slug]/share.png": { fallback: false },
  },
};
const SECURITY_ENTRY = {
  source: "/:path*",
  regex: "^(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$",
  headers: [{ key: "X-Content-Type-Options", value: "nosniff" }],
};

let dir: string;

function write(file: string, content: unknown) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

const manifest = () => JSON.parse(readFileSync(join(dir, "routes-manifest.json"), "utf8"));
const cspEntries = () =>
  manifest().headers.filter((e: { headers: { key: string }[] }) =>
    e.headers.some((h) => h.key === "Content-Security-Policy")
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marketing-csp-"));
  write("app-path-routes-manifest.json", APP_PATHS);
  write("prerender-manifest.json", PRERENDER);
  write("routes-manifest.json", { version: 3, headers: [SECURITY_ENTRY] });
  write("server/app/index.html", page("home"));
  write("server/app/faq.html", page("faq"));
  write("server/app/blog/a-post.html", page("post"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pageScripts", () => {
  test("returns the inline scripts the browser runs, skipping data blocks", () => {
    const { inline, external } = pageScripts(page("x"));
    expect(inline).toEqual([NEXT_INIT, 'self.__next_f.push([1,"x"])']);
    expect(external).toEqual(["/_next/static/chunks/main.js"]);
  });

  test("end tags with whitespace or attributes and upper-case tags still close a script", () => {
    const html = "<SCRIPT>a()</SCRIPT ><script>b()</script\t\n bar><script>c()</script>";
    expect(pageScripts(html).inline).toEqual(["a()", "b()", "c()"]);
  });

  test("a module script is executable, a JSON data block is not", () => {
    const html = '<script type="module">a()</script><script type="application/json">{}</script>';
    expect(pageScripts(html).inline).toEqual(["a()"]);
  });
});

describe("marketingPolicy", () => {
  test("allows only self and the given hashes in script-src, never unsafe sources or a nonce", () => {
    const policy = marketingPolicy({ hashes: ["b", "a", "a"], umami: false });
    const scriptSrc = policy.split("; ").find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBe("script-src 'self' 'sha256-a' 'sha256-b'");
    expect(policy).not.toMatch(/unsafe-eval|nonce|strict-dynamic/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy.split("; ").at(-1)).toBe("report-to csp");
  });

  test("adds Umami's origin only when the page loads it", () => {
    expect(marketingPolicy({ hashes: [], umami: true })).toContain(
      "script-src 'self' https://cloud.umami.is;"
    );
  });
});

describe("prerenderedMarketingPages", () => {
  test("lists each prerendered marketing page, posts expanded, route handlers left out", () => {
    expect(prerenderedMarketingPages(APP_PATHS, PRERENDER)).toEqual(["/", "/blog/a-post", "/faq"]);
  });

  test("a marketing page Next did not prerender fails the build, by name", () => {
    const routes = { ...PRERENDER.routes } as Record<string, { srcRoute: string }>;
    delete routes["/faq"];
    expect(() => prerenderedMarketingPages(APP_PATHS, { ...PRERENDER, routes })).toThrow(
      "marketing routes not prerendered (dynamic): /faq"
    );
  });

  test("a dynamic segment rendered on demand fails, even with prerendered params", () => {
    const dynamicRoutes = { ...PRERENDER.dynamicRoutes, "/blog/[slug]": { fallback: null } };
    expect(() => prerenderedMarketingPages(APP_PATHS, { ...PRERENDER, dynamicRoutes })).toThrow(
      "/blog/[slug]"
    );
  });

  test("a dynamic marketing route handler fails too", () => {
    const routes = { ...PRERENDER.routes } as Record<string, { srcRoute: string }>;
    delete routes["/blog/a-post/share.png"];
    expect(() => prerenderedMarketingPages(APP_PATHS, { ...PRERENDER, routes })).toThrow(
      "/blog/[slug]/share.png"
    );
  });
});

describe("run", () => {
  test("gives each page one exact-path entry hashing exactly its inline scripts", () => {
    expect(run(dir, true)).toEqual(["/", "/blog/a-post", "/faq"]);
    const entries = cspEntries();
    expect(entries.map((e: { source: string }) => e.source)).toEqual(["/", "/blog/a-post", "/faq"]);
    const faq = entries.find((e: { source: string }) => e.source === "/faq");
    expect(faq.regex).toBe("^/faq(?:/)?$");
    const hashes = pageScripts(page("faq")).inline.map(scriptHash);
    expect(faq.headers[0].value).toBe(marketingPolicy({ hashes, umami: false }));
    expect(manifest().headers[0]).toEqual(SECURITY_ENTRY);
  });

  test("running twice replaces its entries instead of doubling them", () => {
    run(dir, true);
    run(dir, true);
    expect(cspEntries()).toHaveLength(3);
  });

  test("check mode fails on a page whose entry was removed after injection", () => {
    run(dir, true);
    const m = manifest();
    m.headers = m.headers.filter((e: { source: string }) => e.source !== "/faq");
    write("routes-manifest.json", m);
    expect(() => run(dir, false)).toThrow("/faq has 0 CSP header entries, expected 1");
  });

  test("check mode fails on a page that runs a script its entry does not hash", () => {
    run(dir, true);
    write("server/app/faq.html", page("faq", "<script>alert(1)</script>"));
    expect(() => run(dir, false)).toThrow("/faq runs 1 inline script(s) its CSP does not hash");
  });

  test("check mode fails on a policy that allows unsafe-inline", () => {
    run(dir, true);
    const m = manifest();
    const entry = m.headers.find((e: { source: string }) => e.source === "/");
    entry.headers[0].value = entry.headers[0].value.replace(
      "script-src 'self'",
      "script-src 'self' 'unsafe-inline'"
    );
    write("routes-manifest.json", m);
    expect(() => run(dir, false)).toThrow("/ allows unsafe script sources");
  });

  test("a script from another origin fails the build instead of shipping a broken page", () => {
    write("server/app/faq.html", page("faq", '<script src="https://cdn.example/x.js"></script>'));
    expect(() => run(dir, true)).toThrow("/faq loads a script the policy cannot allow");
    write("server/app/faq.html", page("faq", '<script src="//cdn.example/x.js"></script>'));
    expect(() => run(dir, true)).toThrow(MarketingCspError);
  });

  test("Umami's script adds its origin to the page's policy", () => {
    write(
      "server/app/faq.html",
      page("faq", '<script defer src="https://cloud.umami.is/script.js"></script>')
    );
    run(dir, true);
    const faq = cspEntries().find((e: { source: string }) => e.source === "/faq");
    expect(faq.headers[0].value).toContain("https://cloud.umami.is");
    const home = cspEntries().find((e: { source: string }) => e.source === "/");
    expect(home.headers[0].value).not.toContain("https://cloud.umami.is");
  });

  test("a prerendered page with no HTML fails", () => {
    rmSync(join(dir, "server/app/blog/a-post.html"));
    expect(() => run(dir, true)).toThrow("/blog/a-post is prerendered but");
  });

  test("a routes manifest of another shape fails closed", () => {
    write("routes-manifest.json", { version: 3, headers: [{ source: "/", headers: [] }] });
    expect(() => run(dir, true)).toThrow("unexpected shape");
    write("routes-manifest.json", { version: 3 });
    expect(() => run(dir, true)).toThrow("routes-manifest.json has no headers array");
  });

  test("a missing manifest fails with what to do", () => {
    rmSync(join(dir, "prerender-manifest.json"));
    expect(() => run(dir, true)).toThrow("run next build first");
  });
});

describe("under a build adapter, as on Vercel", () => {
  const CSP = "Content-Security-Policy";
  const PROXY_ROUTE = {
    src: "^/(?!_next/static|api/|(?:faq|blog/a-post|index)?(?:\\.rsc)?$).*$",
    middlewarePath: "/_middleware",
    continue: true,
  };
  const LINK_ROUTE = { src: "^\\/(?:\\/)?$", headers: { Link: HOMEPAGE_LINK }, continue: true };
  const BASE_ROUTES = [
    { src: "^(?:/(.*))?$", headers: { "X-Content-Type-Options": "nosniff" }, continue: true },
    LINK_ROUTE,
    PROXY_ROUTE,
    { handle: "filesystem" },
    { src: "^/faq-elsewhere$", dest: "/faq" },
  ];
  type Route = {
    src?: string;
    handle?: string;
    headers?: Record<string, string>;
    continue?: boolean;
  };
  const config = (out = "output"): { routes: Route[] } =>
    JSON.parse(readFileSync(join(dir, out, "config.json"), "utf8"));
  const cspRoutes = (routes: Route[]) => routes.filter((r) => r.headers?.[CSP] !== undefined);

  beforeEach(() => {
    rmSync(join(dir, "server"), { recursive: true });
    write("output/config.json", { version: 3, routes: BASE_ROUTES });
    write("output/functions/index.prerender-fallback.html", page("home"));
    write("output/functions/faq.prerender-fallback.html", page("faq"));
    write("output/functions/blog/a-post.prerender-fallback.html", page("post"));
  });

  test("writes each page's policy as a header route ahead of the adapter's routes", () => {
    expect(run(dir, true, { NEXT_ADAPTER_PATH: "/adapter.js" })).toEqual([
      "/",
      "/blog/a-post",
      "/faq",
    ]);
    const routes = config().routes;
    expect(routes.slice(0, 3).map((r) => r.src)).toEqual([
      "^/$",
      "^/blog/a-post(?:/)?$",
      "^/faq(?:/)?$",
    ]);
    expect(routes.slice(3)).toEqual(BASE_ROUTES);
    const hashes = pageScripts(page("faq")).inline.map(scriptHash);
    expect(routes[2]).toEqual({
      src: "^/faq(?:/)?$",
      headers: { [CSP]: marketingPolicy({ hashes, umami: false }) },
      continue: true,
    });
    expect(manifest().headers).toEqual([SECURITY_ENTRY]);
  });

  test("a policy only in the routes manifest does not count once the adapter wrote its output", () => {
    const m = manifest();
    injectPolicies(m, new Map([["/", "script-src 'self'; frame-ancestors 'none'"]]));
    write("routes-manifest.json", m);
    expect(() => run(dir, false)).toThrow("/ has 0 CSP header entries, expected 1");
  });

  test("running twice replaces its routes instead of doubling them", () => {
    run(dir, true);
    run(dir, true);
    expect(cspRoutes(config().routes)).toHaveLength(3);
  });

  test("an adapter that left no output config fails instead of falling back to the manifest", () => {
    rmSync(join(dir, "output"), { recursive: true });
    write("server/app/index.html", page("home"));
    write("server/app/faq.html", page("faq"));
    write("server/app/blog/a-post.html", page("post"));
    expect(() => run(dir, true, { NEXT_ADAPTER_PATH: "/adapter.js" })).toThrow(
      "a build adapter ran but"
    );
    expect(run(dir, true, {})).toHaveLength(3);
  });

  test("a prerendered page with no fallback HTML in the output fails", () => {
    rmSync(join(dir, "output/functions/faq.prerender-fallback.html"));
    expect(() => run(dir, true)).toThrow("/faq is prerendered but");
  });

  test("a policy route placed after the first handle does not count", () => {
    run(dir, true);
    const c = config();
    const faq = c.routes.findIndex((r) => r.src === "^/faq(?:/)?$");
    const [route] = c.routes.splice(faq, 1);
    c.routes.push(route);
    write("output/config.json", c);
    expect(() => run(dir, false)).toThrow("/faq has 0 CSP header entries, expected 1");
  });

  test("a policy that allows framing or unsafe-eval fails", () => {
    run(dir, true);
    const framed = config();
    framed.routes[0].headers![CSP] = framed.routes[0].headers![CSP].replace(
      "frame-ancestors 'none'; ",
      ""
    );
    write("output/config.json", framed);
    expect(() => run(dir, false)).toThrow("/ has no frame-ancestors 'none'");
    run(dir, true);
    const evaled = config();
    evaled.routes[0].headers![CSP] = evaled.routes[0].headers![CSP].replace(
      "script-src 'self'",
      "script-src 'self' 'unsafe-eval'"
    );
    write("output/config.json", evaled);
    expect(() => run(dir, false)).toThrow("/ allows unsafe script sources");
  });

  test("a page whose served HTML runs a script its route does not hash fails", () => {
    run(dir, true);
    write("output/functions/faq.prerender-fallback.html", page("faq", "<script>alert(1)</script>"));
    expect(() => run(dir, false)).toThrow("/faq runs 1 inline script(s) its CSP does not hash");
  });

  test("a CSP route that reaches a nonce path fails, in any letter case", () => {
    run(dir, true);
    for (const src of ["^/cosign$", "^/MAINNET$"]) {
      const c = config();
      c.routes.unshift({ src, headers: { [CSP]: "script-src 'self'" } });
      write("output/config.json", c);
      expect(() => run(dir, false)).toThrow("is matched by a marketing CSP route");
      c.routes.shift();
      write("output/config.json", c);
    }
  });

  test("a nonce path the proxy's route no longer covers fails", () => {
    run(dir, true);
    const c = config();
    const proxy = c.routes.find((r) => r.src === PROXY_ROUTE.src)!;
    proxy.src = PROXY_ROUTE.src.replace("api/|", "api/|api-keys|");
    write("output/config.json", c);
    expect(() => run(dir, false)).toThrow(
      "/api-keys is not matched by the proxy's route, so it would have no nonce policy"
    );
  });

  test("the homepage keeps its discovery Link header next to its CSP route", () => {
    run(dir, true);
    const routes = config().routes;
    expect(routes[0]!.src).toBe("^/$");
    expect(routes.find((r) => r.headers?.Link !== undefined)).toEqual(LINK_ROUTE);
  });

  test("a homepage without the discovery Link header, or with another one, fails", () => {
    run(dir, true);
    const c = config();
    const link = c.routes.find((r) => r.headers?.Link !== undefined)!;
    link.headers = { Link: '</llms.txt>; rel="describedby"' };
    write("output/config.json", c);
    expect(() => run(dir, false)).toThrow("expected exactly the discovery links");
    c.routes = c.routes.filter((r) => r !== link);
    write("output/config.json", c);
    expect(() => run(dir, false)).toThrow("/ has Link header []");
  });

  test("a Link header route after the first handle does not count for the homepage", () => {
    run(dir, true);
    const c = config();
    c.routes = c.routes.filter((r) => r.headers?.Link === undefined);
    c.routes.push(LINK_ROUTE);
    write("output/config.json", c);
    expect(() => run(dir, false)).toThrow("/ has Link header []");
  });

  test("a Link header route that reaches another page or a nonce path fails", () => {
    run(dir, true);
    for (const src of ["^/(.+)$", "^/faq$", "^/COSIGN$"]) {
      const c = config();
      c.routes.unshift({ src, headers: { Link: '</x>; rel="next"' }, continue: true });
      write("output/config.json", c);
      expect(() => run(dir, false)).toThrow("has a Link header route");
    }
  });

  test("check-output verifies the finished deployment output, not the build's copy", () => {
    run(dir, true);
    const out = join(dir, "vercel-output");
    cpSync(join(dir, "output"), out, { recursive: true });
    expect(checkOutput(dir, out)).toEqual(["/", "/blog/a-post", "/faq"]);
    const c = config("vercel-output");
    c.routes = c.routes.filter((r) => r.src !== "^/blog/a-post(?:/)?$");
    write("vercel-output/config.json", c);
    expect(() => checkOutput(dir, out)).toThrow("/blog/a-post has 0 CSP header entries");
    rmSync(join(out, "config.json"));
    expect(() => checkOutput(dir, out)).toThrow("config.json is missing");
  });

  test("an output config that cannot be parsed fails instead of falling back to the manifest", () => {
    write("server/app/index.html", page("home"));
    write("server/app/faq.html", page("faq"));
    write("server/app/blog/a-post.html", page("post"));
    write("output/config.json", '{"version":3,"routes":[');
    expect(() => run(dir, true, {})).toThrow("config.json is not valid JSON");
    expect(manifest().headers).toEqual([SECURITY_ENTRY]);
  });

  test("an output config of another shape fails closed", () => {
    write("output/config.json", { version: 3 });
    expect(() => run(dir, true)).toThrow("the Build Output config has no routes array");
  });
});

test("the build output check covers exactly the golden nonce paths", () => {
  const golden = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/nonce-csp-golden.json"), "utf8")
  );
  expect([...NONCE_PATHS].sort()).toEqual(Object.keys(golden).sort());
});

test("the exact-path regex matches the path and its trailing slash only", () => {
  expect(new RegExp(exactPathRegex("/faq")).test("/faq/")).toBe(true);
  expect(new RegExp(exactPathRegex("/faq")).test("/faqx")).toBe(false);
  expect(new RegExp(exactPathRegex("/")).test("/")).toBe(true);
  expect(new RegExp(exactPathRegex("/")).test("/faq")).toBe(false);
});
