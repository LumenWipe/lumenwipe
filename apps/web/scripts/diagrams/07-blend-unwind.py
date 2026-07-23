"""
LumenWipe - 07 Blend Protocol Unwind
Blend is the largest lending market on Stellar.
Positions: supply (bTokens), borrow (dTokens), backstop deposits.
Exit order is enforced: repay all debt first, then withdraw supply/collateral.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("blend-unwind")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="polyline",
    size="14,17",
    nodesep="0.6",
    ranksep="0.75",
    label=hl(
        "LumenWipe - Blend Protocol Unwind",
        "Blend V1 / V2  ·  supply (bToken) · borrow (dToken) · backstop  ·  via @blend-capital/blend-sdk",
    ),
))
g.attr("node", **base_node_attr())
g.attr("edge", **base_edge_attr())

def diamond(g, nid, label, sub=""):
    l = hl(label, sub) if sub else label
    g.node(nid, l, shape="diamond", fillcolor=F_DECISION, color=B_DECISION,
           penwidth="2", margin="0.35,0.2")

# ── Detection ─────────────────────────────────────────────────────────────────
g.node("detect",
       hl("Detect Blend Position", "Via OctoPos DeFi Position API",
          "Supply (bTokens) · Debt (dTokens) · Backstop · per-pool health factors"),
       fillcolor=F_EXTERNAL, color=B_EXTERNAL)

g.node("ver",
       hl("Resolve Pool Version", "Read wasmHash from contract on-chain",
          "V1 (older pools) or V2 (newer pools)  ·  unknown wasmHash: position blocked with explanation"),
       fillcolor=F_DEFAULT, color=B_DEFAULT)

g.node("emissions",
       hl("Check Unclaimed BLND Emissions", "Blend SDK reads accrued rewards",
          "User offered to claim before exit (OctoPos does not report emissions)"),
       fillcolor=F_DEFAULT, color=B_DEFAULT)

diamond(g, "has_debt",
        "Open dToken Debt?",
        "dTokens represent borrowed assets · must be repaid before collateral withdrawal")

# ── Acquire repayment asset ───────────────────────────────────────────────────
diamond(g, "has_asset",
        "Holds Repayment Asset?",
        "Account must hold the borrowed token to repay")

g.node("acquire",
       hl("Acquire Repayment Asset", "Route via Soroswap API or SDEX path payment",
          "Swap XLM (or another held asset) for the borrowed token at current market rate"),
       fillcolor=F_DECISION, color=B_DECISION)

# ── Repay ─────────────────────────────────────────────────────────────────────
g.node("repay",
       hl("Repay Debt", "Pool.submit (RequestType 5 = Repay)",
          "Blend pulls exact stated amount · refunds any excess in same tx\n"
          "Tool caps repay at balance held - avoids overdraft"),
       fillcolor=F_BACKEND, color=B_BACKEND)

# ── Health factor gate ────────────────────────────────────────────────────────
diamond(g, "hf",
        "Health Factor ≥ 1.0 after repay?",
        "Protocol rejects withdrawal that would undercollateralize remaining positions")

g.node("hf_block",
       hl("BLOCKED - Liquidation Risk", "Withdrawing collateral would undercollateralize position",
          "Shown in plain language · user must repay more before tool can proceed"),
       fillcolor=F_DANGER, color=B_DANGER, penwidth="2")

# ── Withdraw ──────────────────────────────────────────────────────────────────
g.node("withdraw",
       hl("Withdraw Supply / Collateral", "Pool.submit (RequestType 1 = Withdraw  or  3 = WithdrawCollateral)",
          "Supplied and collateralized balances tracked separately - correct request type per position\n"
          "Pass amount greater than balance: clamps to actual balance for a full exit with no dust"),
       fillcolor=F_BACKEND, color=B_BACKEND)

# ── Backstop gate ─────────────────────────────────────────────────────────────
diamond(g, "backstop",
        "Backstop Deposit?",
        "Backstop is the pool's insurance layer - separate from supply")

with g.subgraph(name="cluster_q4w") as q:
    q.attr(label=hl("Queue-for-Withdrawal (Q4W) Cooldown"),
           style="rounded,dashed", color=B_DANGER, fontcolor=B_DANGER,
           fontname=FONT, fontsize="10", penwidth="1.2")
    q.node("q4w_check",
           hl("Already Queued?", "Check Q4W status on-chain"),
           shape="diamond", fillcolor=F_DECISION, color=B_DECISION, penwidth="2", margin="0.3,0.2")
    q.node("queue_start",
           hl("Start Q4W Queue", "Call withdraw on the backstop module",
              "V1: 21-day cooldown  ·  V2: 17-day cooldown  ·  Backstop token = BLND:USDC 80/20 Comet LP share"),
           fillcolor=F_DANGER, color=B_DANGER)
    q.node("q4w_wait",
           hl("Backstop Funds Locked", "Wind-down continues with remaining steps",
              "User warned funds unavailable until cooldown ends · shown remaining time"),
           fillcolor=F_DANGER, color=B_DANGER)

# ── Terminal ──────────────────────────────────────────────────────────────────
g.node("done",
       hl("Blend Position Closed", "bTokens redeemed · dToken debt cleared · proceeds in XLM",
          "Flows into asset conversion step"),
       shape="ellipse", fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2")

# ── Edges ─────────────────────────────────────────────────────────────────────
g.edge("detect",    "ver")
g.edge("ver",       "emissions")
g.edge("emissions", "has_debt")
g.edge("has_debt",  "has_asset", label="yes  - debt exists")
g.edge("has_debt",  "withdraw",  label="no debt",
       color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("has_asset", "repay",    label="yes")
g.edge("has_asset", "acquire",  label="no - acquire first")
g.edge("acquire",   "repay")
g.edge("repay",     "hf")
g.edge("hf",        "withdraw",  label="yes - safe to withdraw",
       color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("hf",        "hf_block",  label="no - would undercollateralize",
       color=E_DANGER, fontcolor=B_DANGER)
g.edge("withdraw",  "backstop")
g.edge("backstop",  "done",      label="no backstop deposit",
       color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("backstop",  "q4w_check", label="has backstop deposit",
       color=E_WARNING, fontcolor=B_DECISION)
g.edge("q4w_check", "q4w_wait",  label="already queued")
g.edge("q4w_check", "queue_start", label="not queued -> queue now",
       color=E_WARNING, fontcolor=B_DECISION)
g.edge("queue_start","q4w_wait")
g.edge("q4w_wait",  "done",
       style="dashed", label="after cooldown ends",
       color=E_SUCCESS, fontcolor=B_SUCCESS)

render(g, "07-blend-unwind")
