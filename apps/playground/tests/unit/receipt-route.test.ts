import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { handleReceipt } from "@/lib/receipt-handler";
import { RECEIPTS_PER_DAY_PER_IP, type RateLimit } from "@/lib/rate-limit";
import type { TransactionRecord } from "@/lib/horizon-submit";
import captured from "../fixtures/receipt-testnet.json";

// GET /api/receipt: public testnet data by hash, for one account, with no session behind it.

const ACCOUNT = Keypair.random().publicKey();
const HASH = "ab".repeat(32);

function request(query: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3002/api/receipt");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { headers: { "x-real-ip": "203.0.113.7" } });
}

const allow: RateLimit = async () => null;
const never = async (): Promise<TransactionRecord | null> => {
  throw new Error("must not be read");
};

describe("the receipt route", () => {
  test("refuses anything but a public key and a lowercase 64-hex hash, before any read", async () => {
    const queries: Record<string, string>[] = [
      { account: ACCOUNT },
      { hash: HASH },
      { account: "GDEMO", hash: HASH },
      { account: ACCOUNT, hash: HASH.toUpperCase() },
      { account: ACCOUNT, hash: HASH.slice(1) },
      { account: ACCOUNT, hash: `${HASH}0` },
      { account: ACCOUNT, hash: `${HASH.slice(2)}/x` },
    ];
    for (const query of queries) {
      const res = await handleReceipt(request(query), { rateLimit: allow, load: never });
      expect(res.status).toBe(400);
    }
  });

  test("is rate limited per caller before anything is read", async () => {
    const seen: [string, number][] = [];
    const res = await handleReceipt(request({ account: ACCOUNT, hash: HASH }), {
      rateLimit: async (_req, namespace, limit) => {
        seen.push([namespace, limit]);
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      },
      load: never,
    });
    expect(res.status).toBe(429);
    expect(seen).toEqual([["receipt", RECEIPTS_PER_DAY_PER_IP]]);
  });

  test("answers pending, uncached, for a hash the network does not know yet", async () => {
    const res = await handleReceipt(request({ account: ACCOUNT, hash: HASH }), {
      rateLimit: allow,
      load: async () => null,
    });
    expect(await res.json()).toEqual({ hash: HASH, status: "pending" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("answers unavailable, uncached, when the read fails", async () => {
    const res = await handleReceipt(request({ account: ACCOUNT, hash: HASH }), {
      rateLimit: allow,
      load: async () => {
        throw new Error("Horizon transaction fetch failed (503)");
      },
    });
    expect(await res.json()).toEqual({ hash: HASH, status: "unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("answers unavailable, uncached, for a record it cannot decode", async () => {
    const res = await handleReceipt(request({ account: ACCOUNT, hash: HASH }), {
      rateLimit: allow,
      load: async () => ({ successful: true, envelopeXdr: "AAAA", resultXdr: "AAAA" }),
    });
    expect(await res.json()).toEqual({ hash: HASH, status: "unavailable" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("caches a read receipt for good: a confirmed result never changes", async () => {
    const classic = captured.find((f) => f.name === "classic")!;
    const res = await handleReceipt(request({ account: classic.account, hash: classic.hash }), {
      rateLimit: allow,
      load: async (hash) => {
        expect(hash).toBe(classic.hash);
        return {
          successful: classic.horizon.successful,
          envelopeXdr: classic.horizon.envelope_xdr,
          resultXdr: classic.horizon.result_xdr,
        };
      },
    });
    expect(await res.json()).toEqual(
      expect.objectContaining({ status: "read", feeStroops: classic.horizon.fee_charged })
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
