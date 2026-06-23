"""
LumenWipe - 06 Ordered Demolition Execution Plan
9-step deterministic pipeline. Order satisfies ledger constraints:
cannot remove a trustline while it holds a balance; cannot merge with subentries remaining.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("execution-plan")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="polyline",
    size="13,17",
    nodesep="0.35",
    ranksep="0.45",
    label=hl(
        "LumenWipe - Ordered Demolition Execution Plan",
        "Same account state always produces the same plan · steps batch to 100 ops/tx · no-ops skipped",
    ),
))
g.attr("node", **base_node_attr(width="7.5", margin="0.3,0.18"))
g.attr("edge", **base_edge_attr(penwidth="2"))

def step(g, nid, num, title, ops, detail, **kw):
    label = hl(f"{num} · {title}", ops, detail)
    g.node(nid, label, **kw)

# ── Steps ─────────────────────────────────────────────────────────────────────
step(g, "s1", "Step 1", "Normalize Signers",
     "SetOptions  ·  weight = 0 per extra signer  ·  thresholds -> 0/1/1",
     "Not a merge precondition, but runs first: collapses multi-sig to one key for all later steps\n"
     "Frees 0.5 XLM per removed signer mid-flow, available to cover fees",
     fillcolor=F_CLIENT, color=B_CLIENT)

step(g, "s2", "Step 2", "Remove Data Entries",
     "ManageData  ·  value = null (delete)  ·  batched ≤ 100 ops / tx",
     "Data entries block AccountMerge  ·  common use: TOML, federation, app metadata",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s3", "Step 3", "Claim Claimable Balances",
     "ClaimClaimableBalance  ·  optional - user-selected",
     "Sponsoring a claimable balance blocks the merge  ·  claimed proceeds flow into conversion step",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s4", "Step 4", "Cancel DEX Offers",
     "ManageSellOffer / ManageBuyOffer  ·  amount = 0 (delete)  ·  batched ≤ 100 ops / tx",
     "Removes buying liabilities, which must be zero before trustlines can be deleted\n"
     "Passive sell offers cancelled the same way  ·  each freed offer returns 0.5 XLM reserve",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s5", "Step 5", "Withdraw AMM &amp; LP Positions",
     "Classic: LiquidityPoolWithdraw  ·  Soroban: remove_liquidity per protocol",
     "Classic pool-share trustline = 2 base reserves  ·  withdraw before trustline removal\n"
     "Soroban: Soroswap router  ·  Phoenix withdraw_liquidity + unbond  ·  Aquarius withdraw",
     fillcolor=F_EXTERNAL, color=B_EXTERNAL)

step(g, "s6", "Step 6", "Exit DeFi Protocols",
     "InvokeHostFunction  ·  one transaction per protocol exit  ·  simulated before signing",
     "Blend: repay dToken debt (Pool.submit Repay) -> withdraw bToken (Withdraw / WithdrawCollateral)\n"
     "FxDAO: pay_debt stablecoin -> withdraw XLM collateral  ·  Phoenix: unbond staked position\n"
     "Health factor checked ≥ 1.0 before any collateral withdrawal",
     fillcolor=F_EXTERNAL, color=B_EXTERNAL)

step(g, "s7", "Step 7", "Convert Assets to XLM",
     "PathPaymentStrictSend (classic)  or  InvokeHostFunction swap (Soroban)",
     "Soroswap API: primary - routes across Soroban + classic, builds XDR, client verifies before signing\n"
     "SDEX strict-send path: fallback for pure-classic assets  ·  min_received = quote × (1 − slippage)\n"
     "No route -> user confirms explicit return-to-issuer  ·  never a silent default",
     fillcolor=F_DECISION, color=B_DECISION)

step(g, "s8", "Step 8", "Remove Trustlines",
     "ChangeTrust  ·  limit = 0  ·  batched ≤ 100 ops / tx",
     "Requires: balance = 0  ·  buying liabilities = 0 (guaranteed by step 4)  ·  no pool-share refs\n"
     "Each removed trustline frees 0.5 XLM reserve (pool-share trustlines free 1.0 XLM)",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s9", "Step 9", "Merge Account",
     "AccountMerge  ·  direct or via mediator (exchange destinations)",
     "Transfers entire XLM balance to destination · deletes source account from ledger\n"
     "Destination verified on-chain first  ·  memo required and validated for known exchanges",
     fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2.5")

# ── Fast-path note ────────────────────────────────────────────────────────────
g.node("fastpath",
       hl("Fast Path (most accounts)",
          "Simple accounts collapse to 1–2 signed transactions",
          "Fused CLOSE_ACCOUNT tx: normalize + data + offers + convert + trustlines + merge in one atomic op\n"
          "Exchange destination: fused cleanup tx, then co-signed mediator transfer (2 signatures total)"),
       fillcolor=F_ACCENT, color=B_ACCENT, style="filled,rounded,dashed",
       width="7.5", margin="0.3,0.18")

# ── Pipeline edges ────────────────────────────────────────────────────────────
for a, b in [("s1","s2"),("s2","s3"),("s3","s4"),("s4","s5"),
             ("s5","s6"),("s6","s7"),("s7","s8"),("s8","s9")]:
    g.edge(a, b)

g.edge("s9", "fastpath", style="dashed", label="see note", color=B_ACCENT)

render(g, "06-execution-plan")
