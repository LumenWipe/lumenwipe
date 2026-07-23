import { NextResponse } from "next/server";
import { TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { checkRateLimit, recordMerge } from "@/lib/kv";
import { isValidNetwork, RPC_URLS, NETWORK_PASSPHRASES } from "@/config/networks";
import type { Network } from "@/config/networks";

// Stellar tx hashes are exactly 64 lowercase hex characters
const TX_HASH_RE = /^[a-fA-F0-9]{64}$/;

// ─── Soroban RPC response types ───────────────────────────────────────────────

interface RpcTxResult {
  status: string;
  envelopeXdr?: string;
  resultXdr?: string;
  [key: string]: unknown;
}

interface RpcResponse {
  result?: RpcTxResult;
  error?: { code: number; message: string };
}

interface VerifyResult {
  valid: boolean;
  xlmStroops: string;
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verifies via the Soroban RPC that:
 *   1. The transaction exists and has status SUCCESS.
 *   2. The transaction envelope contains at least one accountMerge operation.
 *   3. Extracts the transferred XLM amount in stroops from the result XDR.
 *
 * Falls back to status-only acceptance if XDR parsing fails due to a protocol
 * version mismatch (the same defensive pattern used elsewhere in this codebase).
 */
async function verifyAccountMerge(txHash: string, network: Network): Promise<VerifyResult> {
  const rpcUrl = RPC_URLS[network];

  let rpcResp: Response;
  try {
    rpcResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: { hash: txHash },
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.error(`Merge verification RPC request failed for tx ${txHash}:`, err);
    return { valid: false, xlmStroops: "0" };
  }

  if (!rpcResp.ok) {
    console.error(`Merge verification RPC returned ${rpcResp.status} for tx ${txHash}`);
    return { valid: false, xlmStroops: "0" };
  }

  let data: RpcResponse;
  try {
    data = await rpcResp.json();
  } catch (err) {
    console.error(`Merge verification RPC returned invalid JSON for tx ${txHash}:`, err);
    return { valid: false, xlmStroops: "0" };
  }

  const result = data.result;
  if (!result || result.status !== "SUCCESS") return { valid: false, xlmStroops: "0" };

  // Parse the transaction envelope to confirm the operation type
  if (result.envelopeXdr) {
    try {
      const passphrase = NETWORK_PASSPHRASES[network];
      const tx = TransactionBuilder.fromXDR(result.envelopeXdr, passphrase);
      if (!tx.operations.some((op) => op.type === "accountMerge")) {
        return { valid: false, xlmStroops: "0" };
      }
    } catch {
      // XDR parse error - testnet may run a newer protocol than the SDK knows.
      // SUCCESS status is confirmed so accept with best-effort pass.
      return { valid: true, xlmStroops: "0" };
    }
  } else {
    // envelopeXdr absent (older node / pruned ledger) - verify op type via resultXdr
    if (!hasAccountMergeResult(result.resultXdr)) {
      return { valid: false, xlmStroops: "0" };
    }
  }

  // Extract transferred XLM stroops from the result XDR
  const xlmStroops = extractMergeStroops(result.resultXdr);

  return { valid: true, xlmStroops };
}

function hasAccountMergeResult(resultXdr: string | undefined): boolean {
  if (!resultXdr) return false;
  try {
    const txResult = xdr.TransactionResult.fromXDR(resultXdr, "base64");
    return txResult
      .result()
      .results()
      .some((op) => {
        try {
          return op.tr().switch().name === "accountMerge";
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/**
 * Parses resultXdr to find the first accountMerge operation result and returns
 * the transferred native balance in stroops as a string.
 * Returns "0" on any parse failure - amount tracking is non-critical.
 */
function extractMergeStroops(resultXdr: string | undefined): string {
  if (!resultXdr) return "0";
  try {
    const txResult = xdr.TransactionResult.fromXDR(resultXdr, "base64");
    const opResults = txResult.result().results();
    for (const op of opResults) {
      const tr = op.tr();
      if (tr.switch().name === "accountMerge") {
        const mergeResult = tr.accountMergeResult();
        if (mergeResult.switch().name === "accountMergeSuccess") {
          return mergeResult.sourceAccountBalance().toString();
        }
      }
    }
  } catch {
    // Defensive: parse errors are non-fatal, count goes in without XLM amount
  }
  return "0";
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // 1. Rate limiting - checked before any expensive work
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // 2. Input validation
  let body: { txHash?: unknown; network?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { txHash, network } = body;

  if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
    return NextResponse.json({ error: "invalid_tx_hash" }, { status: 400 });
  }

  if (typeof network !== "string" || !isValidNetwork(network)) {
    return NextResponse.json({ error: "invalid_network" }, { status: 400 });
  }

  // 3. Verify via Soroban RPC + XDR operation-type check
  const { valid, xlmStroops } = await verifyAccountMerge(txHash, network as Network);
  if (!valid) {
    return NextResponse.json({ error: "tx_not_verified" }, { status: 400 });
  }

  // 4. Atomic deduplication + increment (Lua script)
  try {
    const isNew = await recordMerge(network as Network, txHash, xlmStroops);
    return NextResponse.json({ ok: true, new: isNew });
  } catch (err) {
    console.error(`Failed to record merge stats for tx ${txHash}:`, err);
    return NextResponse.json({ error: "stats_unavailable" }, { status: 503 });
  }
}
