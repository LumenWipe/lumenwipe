"""
LumenWipe - 04 Signing Flow
API-built unsigned envelope -> XDR review -> verify() (trust anchor) -> wallet
or secret key -> sign -> irreversibility confirmation -> submit via API -> poll
-> advance. The API builds the transaction; the browser verifies it against the
user's own choices before signing; the private key never leaves the browser.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from _style import *
import graphviz

g = graphviz.Digraph("signing-flow")
g.attr(**base_graph_attr(
    rankdir="TB",
    splines="polyline",
    size="12,14",
    label=hl(
        "LumenWipe - Transaction Signing Flow",
        "The browser verifies the API-built transaction, then signs · private key never transmitted · submission routed through the API",
    ),
))
g.attr("node", **base_node_attr())
g.attr("edge", **base_edge_attr())

# ── Entry ─────────────────────────────────────────────────────────────────────
g.node("env",
       hl("Unsigned Transaction Envelope", "Built by the API from a live on-chain re-read",
          "Fetched through the key-injecting web proxy · one transaction per round"),
       fillcolor=F_ACCENT, color=B_ACCENT)

g.node("review",
       hl("XDR Review Panel", "Collapsible · human-readable operation list",
          "User can inspect every operation, fee, and sequence number before signing"),
       fillcolor=F_CLIENT, color=B_CLIENT)

# ── Trust anchor ──────────────────────────────────────────────────────────────
g.node("verify",
       hl("verify()  -  Trust Anchor", "Checks the API-built XDR against the user's own choices",
          "Merge only to the destination or mediator · matching memo · no unknown op\n"
          "Expected values come from the user, never the API - a mismatch aborts before signing"),
       fillcolor=F_CLIENT, color=B_CLIENT, penwidth="2.5")

# ── Signing method decision ───────────────────────────────────────────────────
g.node("choice",
       hl("Signing Method?"),
       shape="diamond", fillcolor=F_DECISION, color=B_DECISION, penwidth="2",
       margin="0.35,0.2")

# ── Wallet path ───────────────────────────────────────────────────────────────
with g.subgraph(name="cluster_wallet") as w:
    w.attr(label=hl("Wallet Path  (primary)", "Private key stays inside the wallet - never enters this app"),
           style="rounded,dashed", color=B_CLIENT, fontcolor=B_CLIENT,
           fontname=FONT, fontsize="10", penwidth="1.2")
    w.node("kit",
           hl("stellar-wallets-kit", "signTransaction (all wallets)",
              "signAuthEntry (Freighter · Hana · WalletConnect · Ledger)"),
           fillcolor=F_CLIENT, color=B_CLIENT)

# ── Secret-key path ───────────────────────────────────────────────────────────
with g.subgraph(name="cluster_sk") as s:
    s.attr(label=hl("Secret-Key Path  (advanced)", "For keys not held in any wallet"),
           style="rounded,dashed", color=B_DECISION, fontcolor=B_DECISION,
           fontname=FONT, fontsize="10", penwidth="1.2")
    s.node("sk_in",
           hl("Key loaded in memory only", "Password-field input · never stored",
              "Wiped on completion · abort · navigation away · 'Forget key' click"),
           fillcolor=F_DECISION, color=B_DECISION)

# ── Multi-sig note ────────────────────────────────────────────────────────────
g.node("multisig",
       hl("Multi-sig Accumulation", "Both paths support multiple keypairs",
          "Signatures accumulated on same envelope · each key wiped after signing · submit when thresholds met"),
       fillcolor=F_DEFAULT, color=B_DEFAULT, style="filled,rounded,dashed")

# ── Post-signing ──────────────────────────────────────────────────────────────
g.node("signed",
       hl("Signed XDR", "All required signatures attached", "Thresholds satisfied"),
       fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2")

g.node("confirm",
       hl("Irreversibility Confirmation", "Explicit per-step acknowledgment required",
          "Shows what will change · warns it cannot be undone · user triggers submission"),
       fillcolor=F_DANGER, color=B_DANGER, penwidth="2")

g.node("send",
       hl("Submit via API", "POST /submit -> Stellar RPC sendTransaction",
          "The API forwards the signed transaction to the network"),
       fillcolor=F_ACCENT, color=B_ACCENT)

g.node("poll",
       hl("Poll getTransaction", "Exponential backoff until ledger response",
          "If response lost: check first - never re-submit without verifying"),
       fillcolor=F_EXTERNAL, color=B_EXTERNAL)

g.node("next",
       hl("Step Confirmed - Advance Plan", "Transaction hash recorded in IndexedDB session",
          "Session state transitions to STEP_CONFIRMED -> STEP_EXECUTING (next round)"),
       fillcolor=F_SUCCESS, color=B_SUCCESS, penwidth="2")

# ── Edges ─────────────────────────────────────────────────────────────────────
g.edge("env",    "review")
g.edge("review", "verify")
g.edge("verify", "choice", label="intent matches")
g.edge("choice", "kit",    label="wallet mode")
g.edge("choice", "sk_in",  label="secret-key mode")
g.edge("kit",    "multisig",  style="dashed")
g.edge("sk_in",  "multisig",  style="dashed")
g.edge("kit",    "signed")
g.edge("sk_in",  "signed")
g.edge("multisig", "signed",  style="dashed", label="all signatures\naccumulated")
g.edge("signed", "confirm")
g.edge("confirm","send")
g.edge("send",   "poll")
g.edge("poll",   "next",   label="SUCCESS", color=E_SUCCESS, fontcolor=B_SUCCESS)
g.edge("poll",   "confirm",
       label="FAILED - retry", style="dashed",
       color=E_DANGER, fontcolor=B_DANGER)

render(g, "04-signing-flow")
