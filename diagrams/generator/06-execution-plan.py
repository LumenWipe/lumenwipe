"""
LumenWipe - 06 Ordered Close Execution Plan
The steps in the order buildPlan() emits them and the rounds run them: rounds of their own
first (signers when no single key can sign, DeFi exits, Soroban tokens, classic pool shares,
claims), then the close.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("execution-plan")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="polyline",
    size="13,22",
    nodesep="0.35",
    ranksep="0.4",
    label=hl(
        "LumenWipe - Ordered Close Execution Plan",
        "Same account state always produces the same plan · steps batch to 100 ops/tx · no-ops skipped",
    ),
))
g.attr("node", **base_node_attr(width="7.5", margin="0.3,0.16"))
g.attr("edge", **base_edge_attr(penwidth="2"))

CONDITIONAL = "filled,rounded,dashed"

def step(g, nid, num, title, ops, detail, **kw):
    g.node(nid, hl(f"{num} · {title}", ops, detail), **kw)

# ── Rounds of their own ───────────────────────────────────────────────────────
with g.subgraph(name="cluster_rounds") as r:
    r.attr(label=hl("Rounds of their own, ahead of the close",
                    "Each round is signed, submitted and confirmed before the next is built from live state"),
           style="rounded,dashed", color=B_DEFAULT, fontcolor=T_MED,
           fontname=FONT, fontsize="10", penwidth="1.2")

    step(r, "s1", "Step 1", "Normalize Signers First  (only when no single key can sign the close)",
         "SetOptions  ·  weight = 0 per extra signer  ·  thresholds -> 0/1/1  ·  a transaction of its own",
         "The master key signs it with enough co-signers, then signs every later round alone\n"
         "It does not close the account, so it is emitted only while no later refusal is already known",
         fillcolor=F_CLIENT, color=B_CLIENT, style=CONDITIONAL)

    step(r, "s2", "Step 2", "Exit DeFi Positions",
         "InvokeHostFunction  ·  one Soroban transaction per exit  ·  simulated before signing",
         "Blend, Aquarius, Soroswap, Phoenix (unbond), FxDAO (testnet only)  ·  debt repaid before collateral\n"
         "Proceeds land in trustlines and tokens the steps below dispose of",
         fillcolor=F_EXTERNAL, color=B_EXTERNAL)

    step(r, "s3", "Step 3", "Move Soroban Tokens",
         "One Soroban transaction per token  ·  every transfer first, then every conversion to XLM",
         "A token the user chose to leave is listed with nothing to sign",
         fillcolor=F_EXTERNAL, color=B_EXTERNAL)

    step(r, "s4", "Step 4", "Withdraw Classic Pool Shares",
         "LiquidityPoolWithdraw  ->  ChangeTrust limit = 0 on the share line  ·  up to 50 pools per transaction",
         "Every share, at minimums 1% under what the pool's reserves give when the round is built\n"
         "Proceeds land in its trustlines (an XLM side in its balance) for the close to convert, transfer or return",
         fillcolor=F_DEFAULT, color=B_DEFAULT)

    step(r, "s5", "Step 5", "Claim Claimable Balances",
         "ChangeTrust (add, where a claim needs a trustline)  ->  ClaimClaimableBalance",
         "In a transaction before the close, so the proceeds reach the asset steps instead of being lost\n"
         "A balance the user forfeits is left behind with a warning, never silently",
         fillcolor=F_DEFAULT, color=B_DEFAULT)

# ── The close ─────────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_close") as c:
    c.attr(label=hl("The close",
                    "Steps 6-11 and a direct merge share one transaction\n"
                    "when they fit in 100 operations",
                    "A Soroswap aggregator swap is its own transaction"),
           style="rounded", color=B_CLIENT, fontcolor=B_CLIENT,
           fontname=FONT, fontsize="10", penwidth="2")

    step(c, "s6", "Step 6", "Normalize Signers  (when extra signers exist and step 1 did not run)",
         "SetOptions  ·  weight = 0 per extra signer  ·  thresholds -> 0/1/1",
         "Not a merge precondition: collapses multisig to one key and frees 0.5 XLM per removed signer",
         fillcolor=F_CLIENT, color=B_CLIENT, style=CONDITIONAL)

    step(c, "s7", "Step 7", "Revoke Sponsorships",
         "RevokeSponsorship  ·  entries this account sponsors on other accounts",
         "Revoked only when the owner can absorb the reserve  ·  the rest, and claimable-balance\n"
         "sponsorships, surface as blockers",
         fillcolor=F_DEFAULT, color=B_DEFAULT)

    step(c, "s8", "Step 8", "Remove Data Entries",
         "ManageData  ·  value = null (delete)",
         "Data entries block AccountMerge",
         fillcolor=F_DEFAULT, color=B_DEFAULT)

    step(c, "s9", "Step 9", "Cancel Offers",
         "ManageSellOffer / ManageBuyOffer  ·  amount = 0 (delete)",
         "Clears the liabilities that must be zero before a trustline can be removed",
         fillcolor=F_DEFAULT, color=B_DEFAULT)

    step(c, "s10", "Step 10", "Handle Each Asset",
         "PathPaymentStrictSend / swap  ·  Payment to an account the user named  ·  Payment to the issuer",
         "Convert to XLM, transfer intact, or return to the issuer, as the user chose per asset\n"
         "Routes re-quoted at build time  ·  a lost route refuses the build, never a silent default",
         fillcolor=F_DECISION, color=B_DECISION)

    step(c, "s11", "Step 11", "Remove Trustlines",
         "ChangeTrust  ·  limit = 0",
         "Requires balance = 0 and no liabilities",
         fillcolor=F_DEFAULT, color=B_DEFAULT)

    step(c, "s12", "Step 12", "Merge Account",
         "AccountMerge to the destination  ·  exchange destination: the co-signed mediator transaction, last",
         "Direct: the merge is the last operation of the close  ·  Exchange: the close removes everything but\n"
         "the merge, then AccountMerge into the mediator and the forward Payment run in one transaction of their own",
         fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2.5")

# ── Pipeline edges ────────────────────────────────────────────────────────────
order = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12"]
for a, b in zip(order, order[1:]):
    g.edge(a, b)

render(g, "06-execution-plan")
