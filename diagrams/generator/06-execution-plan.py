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
step(g, "s1", "Step 1", "Exit DeFi Positions",
     "InvokeHostFunction  ·  one transaction per protocol exit  ·  simulated before signing",
     "Blend: repay dToken debt (Pool.submit Repay) -> withdraw bToken (Withdraw / WithdrawCollateral)\n"
     "FxDAO (testnet only): pay_debt stablecoin -> withdraw XLM collateral  ·  Phoenix: unbond staked position\n"
     "Health factor checked ≥ 1.0 before any collateral withdrawal  ·  proceeds land in trustlines handled later",
     fillcolor=F_EXTERNAL, color=B_EXTERNAL)

step(g, "s2", "Step 2", "Normalize Signers",
     "SetOptions  ·  weight = 0 per extra signer  ·  thresholds -> 0/1/1",
     "Not a merge precondition, but runs early: collapses multi-sig to one key for all later steps\n"
     "Frees 0.5 XLM per removed signer mid-flow, available to cover fees",
     fillcolor=F_CLIENT, color=B_CLIENT)

step(g, "s3", "Step 3", "Revoke Sponsorships",
     "RevokeSponsorship  ·  entries this account sponsors for other accounts",
     "Sponsoring other accounts blocks AccountMerge  ·  revoked only when the owner can absorb the reserve\n"
     "Claimable-balance sponsorships cannot be revoked and surface as blockers",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s4", "Step 4", "Remove Data Entries",
     "ManageData  ·  value = null (delete)  ·  batched ≤ 100 ops / tx",
     "Data entries block AccountMerge  ·  common use: TOML, federation, app metadata",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s5", "Step 5", "Cancel DEX Offers",
     "ManageSellOffer / ManageBuyOffer  ·  amount = 0 (delete)  ·  batched ≤ 100 ops / tx",
     "Removes buying liabilities, which must be zero before trustlines can be deleted\n"
     "Passive sell offers cancelled the same way  ·  each freed offer returns 0.5 XLM reserve",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s6", "Step 6", "Claim Claimable Balances",
     "ClaimClaimableBalance  ·  optional - user-selected",
     "Sponsoring a claimable balance blocks the merge  ·  claimed proceeds flow into the asset step\n"
     "A trustline is added first when the user chooses that remedy",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s7", "Step 7", "Handle Assets",
     "Per asset: PathPaymentStrictSend / swap  ·  Payment to a trustline holder  ·  Payment to the issuer",
     "Three peer dispositions, chosen per asset: convert to XLM, transfer intact, or return to the issuer\n"
     "Soroswap API primary (Soroban + classic, client verifies XDR)  ·  SDEX strict-send fallback\n"
     "min_received = quote × (1 − slippage)  ·  no route -> the user resolves it, never a silent default",
     fillcolor=F_DECISION, color=B_DECISION)

step(g, "s8", "Step 8", "Remove Trustlines",
     "ChangeTrust  ·  limit = 0  ·  batched ≤ 100 ops / tx",
     "Requires: balance = 0  ·  buying liabilities = 0 (guaranteed by step 5)\n"
     "Each removed trustline frees 0.5 XLM reserve  ·  liquidity pool shares are a blocker, not unwound",
     fillcolor=F_DEFAULT, color=B_DEFAULT)

step(g, "s9", "Step 9", "Merge Account",
     "AccountMerge  ·  direct or via mediator (exchange destinations)",
     "Transfers entire XLM balance to destination · deletes source account from ledger\n"
     "Destination verified on-chain first  ·  memo required and validated for known exchanges",
     fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2.5")

# ── Minimal-transactions note ─────────────────────────────────────────────────
g.node("fastpath",
       hl("Minimal set of transactions",
          "Most accounts close in 1–2 signed transactions",
          "Classic steps 2-9 are applied atomically in one transaction  ·  each DeFi exit is its own Soroban transaction\n"
          "Exchange destination: cleanup transaction, then co-signed mediator transfer (2 signatures total)"),
       fillcolor=F_ACCENT, color=B_ACCENT, style="filled,rounded,dashed",
       width="7.5", margin="0.3,0.18")

# ── Pipeline edges ────────────────────────────────────────────────────────────
for a, b in [("s1","s2"),("s2","s3"),("s3","s4"),("s4","s5"),
             ("s5","s6"),("s6","s7"),("s7","s8"),("s8","s9")]:
    g.edge(a, b)

g.edge("s9", "fastpath", style="dashed", label="see note", color=B_ACCENT)

render(g, "06-execution-plan")
