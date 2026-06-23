"""
LumenWipe - 02 Data Acquisition & Execution Flow
How the tool discovers what an account holds, verifies live state,
builds a deterministic plan, and executes it transaction by transaction.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("data-flow")
g.attr(**base_graph_attr(
    rankdir="LR",
    splines="polyline",
    size="16,7",
    label=hl(
        "LumenWipe - Data Acquisition &amp; Execution Flow",
        "Enumerate with indexer · re-read authoritative state over RPC · build plan · simulate · execute",
    ),
))
g.attr("node", **base_node_attr())
g.attr("edge", **base_edge_attr())

# ── Source account ────────────────────────────────────────────────────────────
g.node("acct", hl("Source Account", "Stellar public key"),
       shape="ellipse", fillcolor=F_ACCENT, color=B_ACCENT, penwidth="2")

# ── Parallel scan phase ───────────────────────────────────────────────────────
with g.subgraph(name="cluster_scan") as s:
    s.attr(label=hl("Phase 1 · Scan", "Discover everything the account holds"),
           style="rounded,dashed", color=B_DEFAULT, fontcolor=T_MED,
           fontname=FONT, fontsize="10", penwidth="1.2")
    s.node("enum", hl("Enumerate Subentries", "stellar.expert Indexer API",
                       "Trustlines · offers · data entries · pool shares · signers · sponsorships"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)
    s.node("defi", hl("Detect DeFi Positions", "OctoPos API (mainnet)",
                       "Blend · Aquarius · Soroswap · Phoenix · FxDAO"),
           fillcolor=F_EXTERNAL, color=B_EXTERNAL)

# ── Verify phase ──────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_verify") as v:
    v.attr(label=hl("Phase 2 · Verify Live State", "Never build a transaction from indexer data alone"),
           style="rounded,dashed", color=B_DEFAULT, fontcolor=T_MED,
           fontname=FONT, fontsize="10", penwidth="1.2")
    v.node("reread", hl("Re-read Every Entry", "Stellar RPC · getLedgerEntries",
                         "Authoritative amounts · archived entry detection · sequence numbers"),
           fillcolor=F_CLIENT, color=B_CLIENT)
    v.node("reconcile", hl("Reconcile Completeness", "numSubEntries vs enumerated count",
                            "Mismatch -> surface blocker instead of building an incomplete plan"),
           fillcolor=F_DECISION, color=B_DECISION)

# ── Plan phase ────────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_plan") as p:
    p.attr(label=hl("Phase 3 · Plan", "Deterministic - same state always produces same ordered plan"),
           style="rounded,dashed", color=B_DEFAULT, fontcolor=T_MED,
           fontname=FONT, fontsize="10", penwidth="1.2")
    p.node("plan", hl("Build Execution Plan", "9-step ordered pipeline",
                       "Signers -> Data -> Balances -> Offers -> Pools -> DeFi -> Convert -> Trustlines -> Merge"),
           fillcolor=F_BACKEND, color=B_BACKEND)
    p.node("sim",  hl("Simulate Soroban Steps", "Stellar RPC · simulateTransaction",
                       "Computes footprint · authorization entries · resource fee for every InvokeHostFunction"),
           fillcolor=F_BACKEND, color=B_BACKEND)

# ── Execute loop ──────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_exec") as e:
    e.attr(label=hl("Phase 4 · Execute", "One step at a time · sign · submit · confirm · advance"),
           style="rounded,dashed", color=B_DEFAULT, fontcolor=T_MED,
           fontname=FONT, fontsize="10", penwidth="1.2")
    e.node("sign",   hl("Sign Transaction", "Wallet adapter or in-memory secret key",
                         "User reviews XDR + confirms irreversibility before each step"),
           fillcolor=F_CLIENT, color=B_CLIENT)
    e.node("submit", hl("Submit Signed XDR", "Stellar RPC · sendTransaction",
                         "Client submits directly - never routed through the backend"),
           fillcolor=F_CLIENT, color=B_CLIENT)
    e.node("poll",   hl("Poll for Confirmation", "Stellar RPC · getTransaction",
                         "Exponential backoff · lost-response recovery · marks step confirmed"),
           fillcolor=F_CLIENT, color=B_CLIENT)

# ── Terminal states ───────────────────────────────────────────────────────────
g.node("done",  hl("Account Merged", "AccountMerge confirmed on ledger", "All XLM recovered to destination"),
       shape="ellipse", fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2")
g.node("block", hl("Blocker Surfaced", "Sponsoring other accounts · AUTH_IMMUTABLE · missing route",
                    "Explained in plain language - never silently skipped"),
       shape="ellipse", fillcolor=F_DANGER, color=B_DANGER, penwidth="2")

# ── Edges ─────────────────────────────────────────────────────────────────────
g.edge("acct", "enum")
g.edge("acct", "defi")
g.edge("enum", "reread")
g.edge("defi", "reread")
g.edge("reread",     "reconcile")
g.edge("reconcile",  "plan",   label="counts match")
g.edge("reconcile",  "block",  label="mismatch", color=E_DANGER, fontcolor=B_DANGER)
g.edge("plan",       "sim",    label="Soroban steps")
g.edge("plan",       "sign",   label="classic steps", style="dashed")
g.edge("sim",        "sign")
g.edge("sign",       "submit")
g.edge("submit",     "poll")
g.edge("poll",       "sign",   label="next step", style="dashed")
g.edge("poll",       "done",   label="merge confirmed", color=E_SUCCESS, fontcolor=B_SUCCESS)

render(g, "02-data-flow")
