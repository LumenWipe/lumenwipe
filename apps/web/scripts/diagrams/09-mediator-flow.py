"""
LumenWipe - 09 Mediator Account Flow
Exchanges don't support AccountMerge. They require Payment + memo to credit the user.
The mediator bridges this: one atomic two-operation transaction.
User signs the merge half; backend co-signs the forward payment - only after strict validation.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("mediator-flow")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="polyline",
    size="13,17",
    nodesep="0.55",
    ranksep="0.7",
    label=hl(
        "LumenWipe - Mediator Account Flow (Exchange Destinations)",
        "Exchanges don't support AccountMerge · one atomic two-op transaction bridges the gap",
    ),
))
g.attr("node", **base_node_attr())
g.attr("edge", **base_edge_attr())

def diamond(g, nid, label, sub=""):
    l = hl(label, sub) if sub else label
    g.node(nid, l, shape="diamond", fillcolor=F_DECISION, color=B_DECISION,
           penwidth="2", margin="0.35,0.2")

# ── Why the mediator exists ───────────────────────────────────────────────────
with g.subgraph(name="cluster_why") as w:
    w.attr(label=hl("Why a Mediator is Needed"),
           style="rounded,dashed", color=B_DEFAULT, fontcolor=T_MED,
           fontname=FONT, fontsize="10", penwidth="1.2")
    w.node("why1",
           hl("Exchange Constraint", "No major exchange supports AccountMerge",
              "Direct merge to exchange deposit address -> funds typically lost"),
           fillcolor=F_DANGER, color=B_DANGER)
    w.node("why2",
           hl("Exchange Credit Requirement", "Exchanges credit by: deposit address  +  memo",
              "Payment operation with correct memo type required for crediting"),
           fillcolor=F_DANGER, color=B_DANGER)

# ── Detection ─────────────────────────────────────────────────────────────────
g.node("dest_entry",
       hl("User Enters Destination Address", "Final step of the setup flow",
          "Exchange detection happens at destination entry - depends on the destination"),
       fillcolor=F_CLIENT, color=B_CLIENT)

diamond(g, "is_exchange",
        "Known Exchange / Anchor?",
        "Exchange registry sourced from stellar.expert directory")

g.node("direct_merge",
       hl("Direct AccountMerge", "Destination is a regular wallet address",
          "Standard flow - no mediator needed"),
       fillcolor=F_SUCCESS, color=B_SUCCESS)

# ── Exchange path ─────────────────────────────────────────────────────────────
diamond(g, "has_memo",
        "Memo Provided?",
        "Correct memo type required per registry (text / id / hash)")

g.node("memo_block",
       hl("BLOCKED - Missing Memo", "Submission blocked until memo is provided",
          "Known exchange without memo -> funds would be lost · tool enforces this"),
       fillcolor=F_DANGER, color=B_DANGER, penwidth="2")

# ── Build atomic transaction ──────────────────────────────────────────────────
with g.subgraph(name="cluster_tx") as tx:
    tx.attr(label=hl("Client Builds One Atomic Transaction  (two operations)",
                     "Both operations apply or neither - atomicity guaranteed by Stellar protocol"),
            style="rounded", color=B_CLIENT, fontcolor=B_CLIENT,
            fontname=FONT, fontsize="10", penwidth="2")
    tx.node("op1",
            hl("op 1  -  AccountMerge", "Source account -> Mediator account",
               "Transfers all source XLM into the mediator  ·  source account deleted"),
            fillcolor=F_CLIENT, color=B_CLIENT)
    tx.node("op2",
            hl("op 2  -  Payment", "Mediator -> Exchange deposit address",
               "Carries required memo  ·  amount = all recovered XLM  ·  source: mediator"),
            fillcolor=F_CLIENT, color=B_CLIENT)

# ── Signing split ─────────────────────────────────────────────────────────────
g.node("user_sign",
       hl("User Signs the Transaction", "User's private key signs op1 (AccountMerge)",
          "Key stays in browser · never transmitted · wallet adapter or secret-key mode"),
       fillcolor=F_CLIENT, color=B_CLIENT)

# ── Backend validation + co-sign ─────────────────────────────────────────────
with g.subgraph(name="cluster_validate") as v:
    v.attr(label=hl("Backend Co-Sign  -  Strict Validation First",
                    "Backend holds mediator key · cannot sign for user's account"),
           style="rounded", color=B_BACKEND, fontcolor=B_BACKEND,
           fontname=FONT, fontsize="10", penwidth="2")
    v.node("validate",
           hl("Validate Exact Transaction Shape", "Decodes and checks every field before signing",
              "op1 must be AccountMerge into the mediator  ·  op2 must be Payment from mediator\n"
              "Destination = user's chosen address (cannot be changed)  ·  Amount ≥ 1 XLM"),
           fillcolor=F_BACKEND, color=B_BACKEND)
    v.node("cosign",
           hl("Co-sign op2 with Mediator Key", "Backend signs only the forwarding payment",
              "Cannot sign for user account  ·  cannot redirect destination  ·  cannot change amount"),
           fillcolor=F_BACKEND, color=B_BACKEND)

# ── Submission and outcome ────────────────────────────────────────────────────
g.node("submit",
       hl("Submit Combined Transaction", "Client submits to Stellar RPC · sendTransaction",
          "Signed by user (op1) + mediator key (op2) - both signatures present"),
       fillcolor=F_EXTERNAL, color=B_EXTERNAL)

with g.subgraph(name="cluster_outcome") as o:
    o.attr(label=hl("Atomic Outcome"),
           style="rounded,dashed", color=B_SUCCESS, fontcolor=B_SUCCESS,
           fontname=FONT, fontsize="10", penwidth="1.2")
    o.node("exchange_credit",
           hl("Exchange Credits User", "By deposit address + memo (exactly as provided)",
              "Standard Payment credit - indistinguishable from a normal deposit"),
           fillcolor=F_SUCCESS, color=B_SUCCESS)
    o.node("mediator_stays",
           hl("Mediator Retains ~1 XLM Base Reserve", "Permanent mediator account - reused for every close",
              "User recovers essentially all XLM  ·  only standard network fees apply\n"
              "No per-user 1 XLM sacrifice (unlike throwaway intermediary accounts)"),
           fillcolor=F_DEFAULT, color=B_DEFAULT)

# ── Edges ─────────────────────────────────────────────────────────────────────
g.edge("why1",        "why2", style="invis")  # vertical order in cluster

g.edge("dest_entry",  "is_exchange")
g.edge("is_exchange", "direct_merge",   label="regular wallet",
       color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("is_exchange", "has_memo",       label="exchange / anchor detected",
       color=E_WARNING, fontcolor=B_DECISION)
g.edge("has_memo",    "op1",            label="memo provided")
g.edge("has_memo",    "memo_block",     label="memo missing",
       color=E_DANGER, fontcolor=B_DANGER)

g.edge("op1",         "op2",  label="same atomic tx")
g.edge("op2",         "user_sign")
g.edge("user_sign",   "validate")
g.edge("validate",    "cosign",         label="shape verified",
       color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("validate",    "memo_block",     label="invalid shape -> rejected",
       color=E_DANGER, fontcolor=B_DANGER, style="dashed")
g.edge("cosign",      "submit")
g.edge("submit",      "exchange_credit",
       color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("submit",      "mediator_stays",
       color=E_SUCCESS, fontcolor=B_SUCCESS)

render(g, "09-mediator-flow")
