import { describe, expect, test } from "bun:test";
import {
  NotFoundRoutingError,
  outputFilesFor,
  verifyUnknownSegmentRoute,
} from "../../scripts/not-found-routing.mjs";

const UNKNOWN_SEGMENT_SRC =
  "^(?:\\/((?!(?:mainnet|testnet)(?:[.]|$))[^/]+$))(?:/)?(?<rscsuff>\\.rsc|\\.segments/.+\\.segment\\.rsc)?";

/** The routes of a Vercel build output, trimmed to what the check reads, as the adapter emits them. */
function config(dest: string, extra: { afterFiles?: object[]; error?: object[] } = {}) {
  return {
    routes: [
      { src: "^/public(?:\\/)?$", headers: { Location: "/mainnet" }, status: 308 },
      { handle: "filesystem" },
      { src: "/index(\\.action|\\.rsc)", dest: "/", continue: true },
      { src: UNKNOWN_SEGMENT_SRC, dest, check: true },
      ...(extra.afterFiles ?? []),
      { src: "/(.+)/\\.rsc$", dest: "/$1.rsc", check: true },
      { handle: "resource" },
      { src: "/.*", status: 404 },
      { handle: "rewrite" },
      {
        src: "^[/]?/blog/(?<nxtPslug>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$",
        dest: "/blog/[slug]$2?nxtPslug=$nxtPslug",
        check: true,
      },
      {
        src: "^[/]?/(?<nxtPnetwork>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$",
        dest: "/[network]$2?nxtPnetwork=$nxtPnetwork",
        check: true,
      },
      {
        src: "^[/]?/(?<nxtPnetwork>[^/]+?)/receipt/(?<nxtPid>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$",
        dest: "/[network]/receipt/[id]$3?nxtPnetwork=$nxtPnetwork&nxtPid=$nxtPid",
        check: true,
      },
      { handle: "hit" },
      { handle: "error" },
      ...(extra.error ?? [
        { src: "/.*", dest: "/_not-found", status: 404 },
        { src: "/.*", dest: "/500", status: 500 },
      ]),
    ],
  };
}

const FILES = new Set(["functions/_not-found.func", "functions/[network].func", "static/faq.html"]);
const exists = (file: string) => FILES.has(file);

const check =
  (cfg: object, has = exists) =>
  () =>
    verifyUnknownSegmentRoute(cfg, has);

describe("the unknown-segment routing check", () => {
  test("passes a rewrite to a path the output never serves", () => {
    expect(
      verifyUnknownSegmentRoute(config("/_unmatched/_unmatched$rscsuff?segment=$1"), exists)
    ).toBe("/_unmatched/_unmatched");
  });

  test("fails a rewrite to the global 404's own function, which Vercel serves with 200", () => {
    expect(check(config("/_not-found$rscsuff?segment=$1"))).toThrow(
      /goes to \/_not-found, which the output serves \(functions\/_not-found\.func\)/
    );
  });

  test("fails a rewrite to a prerendered or static path", () => {
    expect(check(config("/faq$rscsuff"))).toThrow(/static\/faq\.html/);
    const prerendered = (file: string) => file === "functions/x/y.prerender-config.json";
    expect(check(config("/x/y"), prerendered)).toThrow(/x\/y\.prerender-config\.json/);
  });

  test("fails a destination a dynamic route matches", () => {
    expect(check(config("/_unmatched"))).toThrow(/goes to \/_unmatched, which .*nxtPnetwork/);
    expect(check(config("/a/receipt/b"))).toThrow(/receipt/);
    expect(check(config("/blog/_x$rscsuff"))).toThrow(/goes to \/blog\/_x, which .*nxtPslug/);
  });

  test("fails without exactly one unknown-segment rewrite", () => {
    const none = config("/_unmatched/_unmatched");
    none.routes = none.routes.filter((r) => !("src" in r) || r.src !== UNKNOWN_SEGMENT_SRC);
    expect(check(none)).toThrow(/found 0/);
    const twice = config("/_unmatched/_unmatched", {
      afterFiles: [{ src: "^/([^/]+)$", dest: "/_other/_other", check: true }],
    });
    expect(check(twice)).toThrow(/found 2/);
  });

  test("fails a rewrite that also takes a network", () => {
    const greedy = config("/_unmatched/_unmatched");
    greedy.routes = greedy.routes.map((r) =>
      "src" in r && r.src === UNKNOWN_SEGMENT_SRC ? { ...r, src: "^/([^/]+)$" } : r
    );
    expect(check(greedy)).toThrow(/takes \/mainnet/);
  });

  test("fails when the error route does not answer the global 404 with status 404", () => {
    const soft = config("/_unmatched/_unmatched", {
      error: [{ src: "/.*", dest: "/_not-found" }],
    });
    expect(check(soft)).toThrow(/status 404/);
    expect(check(config("/_unmatched/_unmatched", { error: [] }))).toThrow(/status 404/);
  });

  test("throws its own error type, so the CLI reports it instead of crashing", () => {
    expect(check({ routes: [] })).toThrow(NotFoundRoutingError);
    expect(check({})).toThrow(/no routes/);
  });

  test("looks for every file kind that would serve the destination", () => {
    expect(outputFilesFor("/a/b")).toEqual([
      "functions/a/b.func",
      "functions/a/b.rsc.func",
      "functions/a/b.prerender-config.json",
      "static/a/b",
      "static/a/b.html",
      "static/a/b.rsc",
      "static/a/b/index.html",
    ]);
  });
});
