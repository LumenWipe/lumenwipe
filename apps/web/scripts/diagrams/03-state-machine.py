"""
LumenWipe - 03 Demolish Flow State Machine
DemolishPhase transitions from IDLE to COMPLETE (or ABORTED).
Each transition is persisted to IndexedDB; resume reconciles against on-chain state.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("state-machine")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="spline",
    size="12,14",
    label=hl(
        "LumenWipe - Demolish Flow State Machine",
        "DemolishPhase · each transition written to IndexedDB · resumable after interruption",
    ),
))
g.attr("node", **base_node_attr(shape="box", style="filled,rounded"))
g.attr("edge", **base_edge_attr())

# ── Start / end pseudostates ──────────────────────────────────────────────────
g.node("__start__", "",
       shape="circle", style="filled", fillcolor=T_DARK, color=T_DARK,
       width="0.3", height="0.3", fixedsize="true")
g.node("__end__", "",
       shape="doublecircle", style="filled", fillcolor=T_DARK, color=T_DARK,
       width="0.3", height="0.3", fixedsize="true")

# ── States ────────────────────────────────────────────────────────────────────
g.node("idle",
       hl("IDLE", "Waiting for source account input"),
       fillcolor=F_DEFAULT, color=B_DEFAULT)

g.node("analyzing",
       hl("ANALYZING", "Reading account state from indexer + RPC",
          "Building plan · checking merge preconditions"),
       fillcolor=F_ACCENT, color=B_ACCENT, penwidth="2")

g.node("preflight",
       hl("PREFLIGHT COMPLETE", "Plan built · blockers resolved",
          "User reviews accordion preview · confirms per-asset dispositions"),
       fillcolor=F_CLIENT, color=B_CLIENT, penwidth="2")

g.node("signer_setup",
       hl("SIGNER SETUP", "Multi-sig account detected",
          "Gathering signatures from multiple keys/wallets"),
       fillcolor=F_DECISION, color=B_DECISION, penwidth="2")

g.node("executing",
       hl("STEP EXECUTING", "Active transaction in flight",
          "API-built · verified against intent · signed · submitted via the API"),
       fillcolor=F_BACKEND, color=B_BACKEND, penwidth="2.5")

g.node("confirmed",
       hl("STEP CONFIRMED", "Ledger confirmed the transaction",
          "Step hash recorded · plan advances"),
       fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2")

g.node("failed",
       hl("STEP FAILED", "Submission or simulation error",
          "Reason shown in plain language · user can retry same step"),
       fillcolor=F_DANGER, color=B_DANGER, penwidth="2")

g.node("complete",
       hl("COMPLETE", "AccountMerge confirmed",
          "All XLM recovered · summary shown"),
       shape="box", style="filled,rounded",
       fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="3")

g.node("aborted",
       hl("ABORTED", "User cancelled or unresolvable blocker",
          "Progress up to last confirmed step is preserved on-chain"),
       shape="box", style="filled,rounded",
       fillcolor=F_DANGER, color=B_DANGER, penwidth="2.5")

# ── Transitions ───────────────────────────────────────────────────────────────
g.edge("__start__", "idle", style="invis")

g.edge("idle",      "analyzing",    label="submit source public key")
g.edge("analyzing", "preflight",    label="analysis OK · plan built", color=E_SUCCESS)
g.edge("analyzing", "aborted",
       label="account not found\nor has unresolvable blocker",
       color=E_DANGER, fontcolor=B_DANGER)

g.edge("preflight", "signer_setup",
       label="multi-sig detected\n(threshold > 1 or multiple keys)",
       color=E_WARNING, fontcolor=B_DECISION)
g.edge("preflight", "executing",    label="single-signer · enter execute loop")

g.edge("signer_setup", "executing",
       label="enough signatures gathered\nthresholds met",
       color=E_WARNING, fontcolor=B_DECISION)

g.edge("executing", "confirmed",
       label="ledger confirms\n(getTransaction -> SUCCESS)",
       color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("executing", "failed",
       label="error: simulation failure\nor submission rejected",
       color=E_DANGER, fontcolor=B_DANGER)
g.edge("executing", "aborted",
       label="user cancels", style="dashed",
       color=E_DANGER, fontcolor=B_DANGER)

g.edge("failed", "executing",
       label="retry same step",
       color=E_WARNING, fontcolor=B_DECISION)
g.edge("failed", "aborted",
       label="user cancels\nor max retries",
       style="dashed", color=E_DANGER, fontcolor=B_DANGER)

g.edge("confirmed", "executing",
       label="advance to next step")
g.edge("confirmed", "complete",
       label="AccountMerge step confirmed",
       color=E_SUCCESS, fontcolor=B_SUCCESS, penwidth="2")

g.edge("complete", "__end__", style="invis")

render(g, "03-state-machine")
