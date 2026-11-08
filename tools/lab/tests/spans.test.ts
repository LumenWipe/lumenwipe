import { describe, expect, test } from "bun:test";
import { spanLabel } from "../src/span-label.ts";
import { breakdown, parseSpans, spansWithin } from "../src/spans";

const UPSTREAMS = {
  "https://rpc.example.org": "rpc",
  "https://provider.example.org/k3y-in-path": "horizon",
  "https://horizon.example.org": "horizon",
  "https://positions.example.org": "defi",
} as const;

describe("spanLabel", () => {
  test("names the RPC method from the JSON-RPC body", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLedgerEntries" });
    expect(spanLabel("https://rpc.example.org", body, UPSTREAMS)).toBe("rpc:getLedgerEntries");
    expect(spanLabel("https://rpc.example.org/", undefined, UPSTREAMS)).toBe("rpc:call");
    expect(spanLabel("https://rpc.example.org", '{"method":"x;y"}', UPSTREAMS)).toBe("rpc:call");
  });

  test("keeps only the route words of a Horizon path, never an address, id or query", () => {
    const address = "GCCD6AJOYZCUAQLX32ZJF2MKFFAUJ53PVCFQI3RHWKL3V47QYE2BNAUT";
    expect(
      spanLabel(
        `https://horizon.example.org/accounts/${address}/offers?limit=200`,
        undefined,
        UPSTREAMS
      )
    ).toBe("horizon:accounts/offers");
    expect(
      spanLabel("https://horizon.example.org/paths/strict-send?x=1", undefined, UPSTREAMS)
    ).toBe("horizon:paths/strict-send");
  });

  test("strips a configured base path, so a key carried in the path never reaches a label", () => {
    const label = spanLabel(
      "https://provider.example.org/k3y-in-path/claimable_balances",
      undefined,
      UPSTREAMS
    );
    expect(label).toBe("horizon:claimable_balances");
    expect(label).not.toContain("k3y");
  });

  test("labels fixed hosts and leaves anything else as other, without its host", () => {
    expect(spanLabel("https://positions.example.org/v1/x", undefined, UPSTREAMS)).toBe("defi");
    expect(spanLabel("https://api.stellar.expert/explorer/x", undefined, UPSTREAMS)).toBe(
      "explorer"
    );
    expect(spanLabel("https://swap-api.xbull.io/swaps", undefined, UPSTREAMS)).toBe("quotes");
    expect(spanLabel("https://unknown.example.net/secret", undefined, UPSTREAMS)).toBe("other");
    expect(spanLabel("not a url", undefined, UPSTREAMS)).toBe("other");
  });
});

describe("breakdown", () => {
  const spans = parseSpans(
    [
      { label: "rpc:getLedgerEntries", start: 1010, end: 1110 },
      { label: "rpc:getLedgerEntries", start: 1050, end: 1150 },
      { label: "horizon:accounts", start: 1200, end: 1300 },
      { label: "horizon:accounts", start: 2500, end: 2600 },
    ]
      .map((s) => JSON.stringify(s))
      .join("\n")
  );

  test("keeps the calls that started inside the request", () => {
    expect(spansWithin(spans, 1000, 1400)).toHaveLength(3);
  });

  test("counts overlapping calls once in upstream time, and the rest as the API's own", () => {
    const b = breakdown(spansWithin(spans, 1000, 1400), 1000, 1400);
    expect(b.upstreams).toEqual({
      "rpc:getLedgerEntries": { calls: 2, ms: 200 },
      "horizon:accounts": { calls: 1, ms: 100 },
    });
    expect(b.upstreamMs).toBe(240);
    expect(b.ownMs).toBe(160);
  });
});
