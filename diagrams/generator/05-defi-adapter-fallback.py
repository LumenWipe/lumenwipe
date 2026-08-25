"""
LumenWipe - 05 DeFi Position Adapter & Fallback
How the backend queries OctoPos, validates freshness,
and gracefully degrades when the provider is unavailable.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("defi-adapter")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="polyline",
    size="13,11",
    label=hl(
        "LumenWipe - DeFi Position Adapter &amp; Fallback",
        "Detects positions across Blend · Aquarius · Soroswap · Phoenix · FxDAO via OctoPos",
    ),
))
g.attr("node", **base_node_attr())
g.attr("edge", **base_edge_attr())

# ── Entry ─────────────────────────────────────────────────────────────────────
g.node("req",
       hl("Analysis Request", "Account public key",
          "Triggered when user submits address for analysis"),
       shape="ellipse", fillcolor=F_ACCENT, color=B_ACCENT, penwidth="2")

# ── Network check ─────────────────────────────────────────────────────────────
g.node("net_check",
       hl("Network?", "Mainnet or Testnet?"),
       shape="diamond", fillcolor=F_DECISION, color=B_DECISION, penwidth="2", margin="0.3,0.2")

g.node("testnet_path",
       hl("Testnet: Direct Contract Reads", "OctoPos is mainnet-only",
          "Reads DeFi state directly via RPC getLedgerEntries + contract registry\n(same code path as degraded mode -> always exercised in CI)"),
       fillcolor=F_BACKEND, color=B_BACKEND)

# ── OctoPos query ─────────────────────────────────────────────────────────────
g.node("octo",
       hl("Query OctoPos", "HTTP · 5 second timeout",
          "Sends only the account address · no user identity stored"),
       fillcolor=F_EXTERNAL, color=B_EXTERNAL)

# ── Freshness gate ────────────────────────────────────────────────────────────
g.node("fresh_gate",
       hl("Freshness Gate", "Check data_staleness_seconds + partial_result"),
       shape="diamond", fillcolor=F_DECISION, color=B_DECISION, penwidth="2", margin="0.3,0.2")

g.node("refresh",
       hl("Request Refresh", "Signal OctoPos to re-index this address",
          "Wait and retry once"),
       fillcolor=F_EXTERNAL, color=B_EXTERNAL)

g.node("refresh_gate",
       hl("Still Fresh Enough?", "Check staleness after refresh"),
       shape="diamond", fillcolor=F_DECISION, color=B_DECISION, penwidth="2", margin="0.3,0.2")

# ── Success path ──────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_normalize") as n:
    n.attr(label=hl("Normalize Position Data", "Adapter maps provider shapes to one internal model"),
           style="rounded,dashed", color=B_SUCCESS, fontcolor=B_SUCCESS,
           fontname=FONT, fontsize="10", penwidth="1.2")
    n.node("normalize",
           hl("Map Provider Response", "Supply (bTokens) · Borrow (dTokens) · LP shares · Backstop",
              "Enriched with asset symbols · USD prices · contract names and versions"),
           fillcolor=F_SUCCESS, color=B_SUCCESS)
    n.node("meta",
           hl("Attach Freshness Metadata", "last_indexed_ledger · staleness · partial_result",
              "Low attribution_confidence -> show notice to verify on explorer"),
           fillcolor=F_SUCCESS, color=B_SUCCESS)

g.node("plan_ready",
       hl("DeFi Positions Ready", "Feed into execution plan builder",
          "Each position becomes one or more exit steps"),
       fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2", shape="ellipse")

# ── Degraded mode ─────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_degraded") as d:
    d.attr(label=hl("Degraded Mode", "OctoPos unavailable or data too stale"),
           style="rounded,dashed", color=B_DANGER, fontcolor=B_DANGER,
           fontname=FONT, fontsize="10", penwidth="1.5")
    d.node("degraded",
           hl("Classic Steps Only", "Trustlines · offers · data entries proceed normally",
              "DeFi positions NOT detected automatically"),
           fillcolor=F_DANGER, color=B_DANGER)
    d.node("warn",
           hl("User Warning Displayed", "DeFi positions could not be detected",
              "User advised to verify Blend · Aquarius · Soroswap · Phoenix · FxDAO manually"),
           fillcolor=F_DANGER, color=B_DANGER)

# ── Edges ─────────────────────────────────────────────────────────────────────
g.edge("req",          "net_check")
g.edge("net_check",    "testnet_path",  label="testnet")
g.edge("net_check",    "octo",          label="mainnet")
g.edge("testnet_path", "plan_ready",    label="positions via RPC",
       color=E_SUCCESS, fontcolor=B_SUCCESS)

g.edge("octo",         "fresh_gate",    label="response received")
g.edge("octo",         "degraded",      label="timeout / error",
       color=E_DANGER, fontcolor=B_DANGER)

g.edge("fresh_gate",   "normalize",     label="fresh")
g.edge("fresh_gate",   "refresh",       label="stale")

g.edge("refresh",      "refresh_gate",  label="response received")
g.edge("refresh",      "degraded",      label="timeout / error",
       color=E_DANGER, fontcolor=B_DANGER)
g.edge("refresh_gate", "normalize",     label="fresh")
g.edge("refresh_gate", "degraded",      label="still stale",
       color=E_DANGER, fontcolor=B_DANGER)

g.edge("normalize",    "meta")
g.edge("meta",         "plan_ready",
       color=E_SUCCESS, fontcolor=B_SUCCESS)

g.edge("degraded",     "warn")

render(g, "05-defi-adapter-fallback")
