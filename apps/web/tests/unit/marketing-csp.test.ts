import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { marketingPolicy } from "@/config/marketing-csp.mjs";
import {
  exactPathRegex,
  MarketingCspError,
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

test("the exact-path regex matches the path and its trailing slash only", () => {
  expect(new RegExp(exactPathRegex("/faq")).test("/faq/")).toBe(true);
  expect(new RegExp(exactPathRegex("/faq")).test("/faqx")).toBe(false);
  expect(new RegExp(exactPathRegex("/")).test("/")).toBe(true);
  expect(new RegExp(exactPathRegex("/")).test("/faq")).toBe(false);
});
