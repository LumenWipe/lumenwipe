/**
 * A stand-in Horizon-compatible endpoint, for demonstrating the account-state provider seam.
 *
 * It forwards every request to SDF's testnet Horizon and prints what it was asked for, so the
 * provider swap is visible rather than asserted: point PATH_ROUTING_API_TESTNET at this and
 * every account read the API makes shows up here, with no code change anywhere.
 *
 * Run from the repo root:
 *
 *   bun run apps/api/scripts/stand-in-horizon.ts             # faithful proxy
 *   bun run apps/api/scripts/stand-in-horizon.ts --diverge   # reports more subentries than exist
 *   bun run apps/api/scripts/stand-in-horizon.ts --break     # omits subentry_count entirely
 *
 * The --break mode is the point. "Horizon-compatible" is a claim a provider makes, and the
 * completeness check is `enumerated < numSubEntries` - which JavaScript evaluates as false
 * against an undefined, so a provider that omits the field would turn the guard the whole
 * design rests on into a permanent, silent "everything is fine". With --break the response is
 * genuinely missing the field, and the API refuses the read instead of building a plan that
 * could leave entries behind.
 */

const UPSTREAM = "https://horizon-testnet.stellar.org";
const PORT = 8787;
const BREAK = process.argv.includes("--break");
const DIVERGE = process.argv.includes("--diverge");
// What a lagging or wrong indexer looks like: the ledger's own count says the account holds
// more reserve-bearing entries than the endpoint can enumerate. It is the one failure the
// completeness check exists to catch, and it cannot be provoked against a healthy Horizon.
const DIVERGED_COUNT = 99;

function stamp(): string {
  // Wall-clock is only ever printed, never used for logic.
  return new Date().toISOString().slice(11, 19);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const target = `${UPSTREAM}${url.pathname}${url.search}`;

    const upstream = await fetch(target, {
      method: req.method,
      headers: { accept: "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
    });

    const isAccountRead = /^\/accounts\/G[A-Z2-7]{55}$/.test(url.pathname);

    if ((BREAK || DIVERGE) && isAccountRead && upstream.ok) {
      const body = (await upstream.json()) as Record<string, unknown>;
      if (BREAK) {
        delete body.subentry_count;
        console.log(`${stamp()}  ${url.pathname}  →  subentry_count REMOVED`);
      } else {
        const real = body.subentry_count;
        body.subentry_count = DIVERGED_COUNT;
        console.log(`${stamp()}  ${url.pathname}  →  subentry_count ${real} → ${DIVERGED_COUNT}`);
      }
      return Response.json(body, { status: upstream.status });
    }

    console.log(`${stamp()}  ${url.pathname}${url.search}  →  ${upstream.status}`);
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  },
});

console.log("");
console.log(`  Stand-in Horizon endpoint   http://localhost:${server.port}`);
console.log(`  Forwarding to               ${UPSTREAM}`);
const mode = BREAK
  ? "BREAK - omits subentry_count"
  : DIVERGE
    ? `DIVERGE - reports subentry_count ${DIVERGED_COUNT}`
    : "faithful proxy";
console.log(`  Mode                        ${mode}`);
console.log("");
console.log("  Point the API at it:");
console.log(`    NEXT_PUBLIC_PATH_ROUTING_API_TESTNET=http://localhost:${server.port}`);
console.log("");
