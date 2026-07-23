"""
LumenWipe - 08 Asset Conversion & Routing
After DeFi positions are unwound, non-XLM balances need a disposition.
Each asset gets an explicit per-asset user choice: swap to XLM or return to issuer.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("asset-conversion")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="polyline",
    size="14,16",
    nodesep="0.6",
    ranksep="0.75",
    label=hl(
        "LumenWipe - Asset Conversion &amp; Routing",
        "Every non-XLM balance gets an explicit per-asset disposition confirmed by the user",
    ),
))
g.attr("node", **base_node_attr())
g.attr("edge", **base_edge_attr())

def diamond(g, nid, label, sub=""):
    l = hl(label, sub) if sub else label
    g.node(nid, l, shape="diamond", fillcolor=F_DECISION, color=B_DECISION,
           penwidth="2", margin="0.35,0.2")

# ── Entry ─────────────────────────────────────────────────────────────────────
g.node("asset",
       hl("Non-XLM Balance", "Classic token (trustline) or Soroban token",
          "Each balance handled independently - no silent batch-swap"),
       shape="ellipse", fillcolor=F_ACCENT, color=B_ACCENT, penwidth="2")

# ── Quote phase ───────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_quote") as q:
    q.attr(label=hl("Quote Phase", "Find best available route at current market price"),
           style="rounded,dashed", color=B_DEFAULT, fontcolor=T_MED,
           fontname=FONT, fontsize="10", penwidth="1.2")
    q.node("soroswap_q",
           hl("Soroswap API  (primary)", "Routes across Soroban DEXes + classic SDEX",
              "Covers classic tokens, Soroban tokens, and SAC-wrapped assets"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)
    q.node("sdex_q",
           hl("SDEX Strict-Send Path  (fallback)", "Horizon-compatible /paths/strict-send",
              "Classic order books + AMM pools · up to 6 hops · used when Soroswap has no route"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)

diamond(g, "has_route",
        "Route Found?",
        "A route exists if at least one path from this asset to XLM is available")

# ── User disposition ──────────────────────────────────────────────────────────
g.node("disp_preview",
       hl("Per-Asset Disposition - User Confirms in Preview", "Shown in accordion before any transaction is built",
          "User makes an explicit choice for every non-XLM balance"),
       fillcolor=F_CLIENT, color=B_CLIENT, penwidth="2")

diamond(g, "disp_choice",
        "User Disposition?",
        "swap = default when route exists  ·  return to issuer always requires explicit confirm")

# ── Slippage protection ───────────────────────────────────────────────────────
g.node("minrecv",
       hl("Compute Minimum Received", "min_received = quoted_out × (1 − slippage_tolerance)",
          "Re-quoted at build time - if route lost, falls back to return-to-issuer"),
       fillcolor=F_BACKEND, color=B_BACKEND)

diamond(g, "token_kind",
        "Token Kind?",
        "Determines which Stellar operation to use")

# ── Swap execution ────────────────────────────────────────────────────────────
g.node("pp",
       hl("PathPaymentStrictSend", "Classic Stellar operation  ·  dest_min = min_received",
          "SDEX order books + classic AMM pools  ·  enforces minimum received on-chain"),
       fillcolor=F_BACKEND, color=B_BACKEND)

g.node("invoke",
       hl("InvokeHostFunction Swap", "Soroban swap via Soroswap router  ·  min_out = min_received",
          "Soroswap API builds XDR  ·  client decodes and verifies contract + amounts before signing"),
       fillcolor=F_BACKEND, color=B_BACKEND)

g.node("swapped",
       hl("Balance Converted to XLM", "Destination receives XLM ≥ min_received",
          "Slippage beyond tolerance causes tx to fail - user retries at new price or lowers tolerance"),
       fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2")

# ── Return-to-issuer path ─────────────────────────────────────────────────────
with g.subgraph(name="cluster_issuer") as i:
    i.attr(label=hl("Return-to-Issuer Path", "Irreversible · explicit confirmation required"),
           style="rounded,dashed", color=B_DANGER, fontcolor=B_DANGER,
           fontname=FONT, fontsize="10", penwidth="1.5")
    i.node("issuer_confirm",
           hl("User Confirms Return to Issuer", "Tool states explicitly: this is irreversible",
              "Never labeled as a 'conversion'  ·  right choice for spam tokens, dust, assets with no route"),
           fillcolor=F_DANGER, color=B_DANGER)
    i.node("issuer_pay",
           hl("Payment to Issuer Address", "Sends full balance back  ·  issuer burns it",
              "Clears balance to zero · enables trustline removal"),
           fillcolor=F_DANGER, color=B_DANGER)

# ── Trustline removal ─────────────────────────────────────────────────────────
g.node("rm_tl",
       hl("Remove Trustline", "ChangeTrust  ·  limit = 0",
          "Preconditions: balance = 0  ·  buying_liabilities = 0  ·  no pool-share references\n"
          "Frees 0.5 XLM base reserve (pool-share trustlines free 1.0 XLM)"),
       fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2", shape="ellipse")

# ── Edges ─────────────────────────────────────────────────────────────────────
g.edge("asset",       "soroswap_q")
g.edge("soroswap_q",  "sdex_q",     label="no route via Soroswap",
       style="dashed", fontcolor=T_MED)
g.edge("soroswap_q",  "has_route",  label="result")
g.edge("sdex_q",      "has_route",  label="result")

g.edge("has_route",   "disp_preview", label="yes - route available")
g.edge("has_route",   "issuer_confirm", label="no route",
       color=E_DANGER, fontcolor=B_DANGER)

g.edge("disp_preview","disp_choice")
g.edge("disp_choice", "minrecv",       label="swap (default)")
g.edge("disp_choice", "issuer_confirm", label="return to issuer\n(explicit)",
       color=E_DANGER, fontcolor=B_DANGER)

g.edge("minrecv",     "token_kind")
g.edge("token_kind",  "pp",     label="classic token")
g.edge("token_kind",  "invoke", label="Soroban token")
g.edge("pp",          "swapped")
g.edge("invoke",      "swapped")
g.edge("swapped",     "rm_tl",
       color=E_SUCCESS, fontcolor=B_SUCCESS)

g.edge("issuer_confirm", "issuer_pay")
g.edge("issuer_pay",     "rm_tl",
       color=E_SUCCESS, fontcolor=B_SUCCESS)

render(g, "08-asset-conversion-routing")
