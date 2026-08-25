"""
LumenWipe - 01 System Architecture
Three-layer view: browser (trust boundary - verifies and signs), the API
service (builds transactions), and the Stellar network. The API builds every
unsigned transaction; the browser verifies each one against the user's own
choices before signing. Private keys never reach any server.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("system-architecture")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="spline",
    size="15,11",
    label=hl(
        "LumenWipe - System Architecture",
        "Non-custodial Stellar account closure · the API builds transactions · the browser verifies and signs",
    ),
))
g.attr("node", **base_node_attr())
g.attr("edge", **base_edge_attr())

# ── Browser (trust boundary) ──────────────────────────────────────────────────
with g.subgraph(name="cluster_browser") as b:
    b.attr(
        label=hl("Browser  -  Trust Boundary", "Verification, signing, and orchestration happen here"),
        style="rounded",
        color=B_CLIENT,
        fontcolor=B_CLIENT,
        fontname=FONT,
        fontsize="12",
        penwidth="2.5",
        margin="18",
    )
    b.node("ui",      hl("Guided UI", "Analyze -> Execute -> Complete", "Plan preview · per-step confirmations · irreversibility warnings"),
           fillcolor=F_CLIENT, color=B_CLIENT)
    b.node("wallet",  hl("Wallet Adapter", "stellar-wallets-kit (SEP-43)", "Freighter · Albedo · LOBSTR · Hana · WalletConnect · more"),
           fillcolor=F_CLIENT, color=B_CLIENT)
    b.node("sk",      hl("Secret-Key Mode", "In-memory only · never persisted", "Wiped on completion, abort, or navigation away"),
           fillcolor=F_CLIENT, color=B_CLIENT)
    b.node("verify",  hl("verify()  -  Trust Anchor", "Checks the API-built XDR against the user's own choices", "Asserts intent before signing · a mismatch aborts · never trusts the API's word"),
           fillcolor=F_CLIENT, color=B_CLIENT, penwidth="2.5")
    b.node("signer",  hl("Signer + XDR Review", "Signs only after verify() passes", "User inspects every operation before signing"),
           fillcolor=F_CLIENT, color=B_CLIENT)
    b.node("sess",    hl("Session Store", "IndexedDB · no keys · no signed envelopes", "Resumable after browser close · reconciles on-chain on re-entry"),
           fillcolor=F_CLIENT, color=B_CLIENT)

# ── Web proxy (server-side) ───────────────────────────────────────────────────
g.node("proxy", hl("Web Proxy  (Next.js, server-side)", "Injects the API key · per-IP rate limit · short-TTL cache", "The browser never holds an API key"),
       fillcolor=F_ACCENT, color=B_ACCENT, penwidth="2")

# ── API service ───────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_backend") as b:
    b.attr(
        label=hl("API Service  -  Builds Transactions · Stateless", "No user keys · no custody · one mediator co-sign key · API-key auth"),
        style="rounded",
        color=B_BACKEND,
        fontcolor=B_BACKEND,
        fontname=FONT,
        fontsize="12",
        penwidth="2.5",
        margin="18",
    )
    b.node("analysis", hl("Account Analysis", "Subentries · blockers · DeFi positions · reserves", "Full pre-flight merge check per §3 result codes"),
           fillcolor=F_BACKEND, color=B_BACKEND)
    b.node("close",    hl("Close Builder", "Builds the minimal unsigned transaction set", "Deterministic plan · re-reads live state · re-derives remaining work each round"),
           fillcolor=F_BACKEND, color=B_BACKEND, penwidth="2.5")
    b.node("defi",     hl("DeFi Position Adapter", "OctoPos proxy · freshness gate · degraded mode", "Blend · Aquarius · Soroswap · Phoenix · FxDAO"),
           fillcolor=F_BACKEND, color=B_BACKEND)
    b.node("route",    hl("Routing Service", "Soroswap API (primary) -> SDEX paths (fallback)", "Quote routes · compute min-received for slippage protection"),
           fillcolor=F_BACKEND, color=B_BACKEND)
    b.node("med_be",   hl("Mediator Co-Sign", "Co-signs the forward payment only", "Validates exact shape · cannot change destination or amount"),
           fillcolor=F_BACKEND, color=B_BACKEND)
    b.node("reg",      hl("Registries", "Exchange deposit addresses -> memo type rules", "Contract wasmHash -> protocol version (Blend V1/V2 · pool IDs)"),
           fillcolor=F_BACKEND, color=B_BACKEND)
    b.node("cache",    hl("Cache", "Short TTLs (seconds)", "Public read data only · no identity · no user keys"),
           fillcolor=F_BACKEND, color=B_BACKEND)

# ── Stellar network & data services ──────────────────────────────────────────
with g.subgraph(name="cluster_network") as n:
    n.attr(
        label=hl("Stellar Network  &amp;  Data Services"),
        style="rounded",
        color=B_EXTERNAL,
        fontcolor=B_EXTERNAL,
        fontname=FONT,
        fontsize="12",
        penwidth="2.5",
        margin="18",
    )
    n.node("rpc", hl("Stellar RPC", "getLedgerEntries · simulateTransaction", "sendTransaction · getTransaction · getEvents"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)
    n.node("idx", hl("Horizon-compatible provider", "Enumerate trustlines · offers · data · signers · pool shares", "Set by configuration; swapping providers needs no code change"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)
    n.node("soro_api", hl("Soroswap API", "Optimal swap routes · LP pair data", "Builds Soroban swap XDR (client verifies before signing)"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)
    n.node("octopos", hl("OctoPos DeFi Position API", "Detects positions across all Soroban DeFi protocols", "Returns freshness metadata · mainnet only"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)
    n.node("ledger", hl("Stellar Ledger", "Classic + Soroban (Protocol 26 · Yardstick)", "Source of truth for all account state"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL,
           shape="cylinder", penwidth="2")

# ── Client internal wiring ────────────────────────────────────────────────────
g.edge("close",  "verify", label="unsigned XDR", color=B_CLIENT, fontcolor=B_CLIENT, penwidth="2", fontsize="9")
g.edge("verify", "signer", label="only if intent matches", color=B_CLIENT, fontcolor=B_CLIENT, fontsize="9")
g.edge("wallet", "signer")
g.edge("sk",     "signer")
g.edge("signer", "sess", label="saves step state", style="dashed")

# ── Client <-> API (through the proxy) ─────────────────────────────────────────
g.edge("ui",     "proxy", label="fetch plan + tx", style="dashed", color=B_DEFAULT)
g.edge("proxy",  "analysis", label="read + build\n(key injected)", color=B_ACCENT, fontcolor=B_ACCENT, penwidth="2", fontsize="9")
g.edge("proxy",  "close")
g.edge("signer", "proxy", label="signed XDR -> submit", color=B_CLIENT, fontcolor=B_CLIENT, penwidth="2", fontsize="9")
g.edge("proxy",  "med_be", label="mediator co-sign", style="dashed")

# ── API internal ──────────────────────────────────────────────────────────────
g.edge("close",    "analysis", style="dashed")
g.edge("analysis", "defi")
g.edge("analysis", "cache",   style="dashed")
g.edge("med_be",   "rpc",     style="dashed")

# ── API -> external ───────────────────────────────────────────────────────────
g.edge("analysis", "idx")
g.edge("analysis", "rpc")
g.edge("close",    "rpc",     label="live reads · submit", penwidth="2")
g.edge("defi",     "octopos")
g.edge("route",    "soro_api")
g.edge("route",    "idx",    label="SDEX paths fallback", style="dashed")

# ── External -> ledger ─────────────────────────────────────────────────────────
g.edge("rpc",      "ledger", penwidth="2")
g.edge("idx",      "ledger")
g.edge("soro_api", "ledger")
g.edge("octopos",  "ledger")

render(g, "01-system-architecture")
