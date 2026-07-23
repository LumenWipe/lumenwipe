"""
Shared design system for all LumenWipe diagrams.
Professional palette · transparent background · light/dark mode compatible.
"""

# ── Background ────────────────────────────────────────────────────────────────
BGCOLOR = "transparent"

# ── Typography ────────────────────────────────────────────────────────────────
FONT = "Helvetica"
T_DARK = "#1E293B"   # slate-900 - primary text
T_MED  = "#475569"   # slate-600 - secondary / edge labels
T_LITE = "#94A3B8"   # slate-400 - minor annotations

# ── Node fills (light, opaque) - show as "cards" on dark backgrounds ─────────
F_DEFAULT  = "#F8FAFC"   # slate-50       general nodes
F_CLIENT   = "#EFF6FF"   # blue-50        browser / client
F_BACKEND  = "#F0FDF4"   # green-50       read-only backend
F_EXTERNAL = "#FAF5FF"   # purple-50      external services / Stellar network
F_DECISION = "#FFFBEB"   # amber-50       decision / gate nodes
F_SUCCESS  = "#ECFDF5"   # emerald-50     success / terminal states
F_DANGER   = "#FEF2F2"   # red-50         error / blocker states
F_ACCENT   = "#F0F9FF"   # sky-50         accent / highlight nodes

# ── Borders ───────────────────────────────────────────────────────────────────
B_DEFAULT  = "#64748B"   # slate-500
B_CLIENT   = "#3B82F6"   # blue-500
B_BACKEND  = "#16A34A"   # green-600
B_EXTERNAL = "#9333EA"   # purple-600
B_DECISION = "#D97706"   # amber-600
B_SUCCESS  = "#059669"   # emerald-600
B_DANGER   = "#DC2626"   # red-600
B_ACCENT   = "#0284C7"   # sky-600

# ── Edges ─────────────────────────────────────────────────────────────────────
E_DEFAULT  = "#94A3B8"   # slate-400
E_SUCCESS  = "#059669"   # emerald-600
E_DANGER   = "#DC2626"   # red-600
E_WARNING  = "#D97706"   # amber-600


def render(g, name: str, out: str = "docs/diagrams/output") -> None:
    """Render graph to both SVG and PNG."""
    from pathlib import Path
    Path(out).mkdir(parents=True, exist_ok=True)
    svg = g.pipe(format="svg")
    png = g.pipe(format="png")
    Path(f"{out}/{name}.svg").write_bytes(svg)
    Path(f"{out}/{name}.png").write_bytes(png)
    print(f"  ✓ {name}  (.svg + .png)")


def base_graph_attr(**extra):
    return {
        "bgcolor": BGCOLOR,
        "fontname": FONT,
        "fontsize": "13",
        "fontcolor": T_DARK,
        "labelloc": "t",
        "labeljust": "l",
        "pad": "0.7",
        "nodesep": "0.55",
        "ranksep": "0.8",
        "dpi": "150",
        **extra,
    }


def base_node_attr(**extra):
    return {
        "shape": "box",
        "style": "filled,rounded",
        "fillcolor": F_DEFAULT,
        "color": B_DEFAULT,
        "fontname": FONT,
        "fontsize": "11",
        "fontcolor": T_DARK,
        "margin": "0.22,0.13",
        "penwidth": "1.6",
        **extra,
    }


def base_edge_attr(**extra):
    return {
        "color": E_DEFAULT,
        "fontname": FONT,
        "fontsize": "10",
        "fontcolor": T_MED,
        "arrowsize": "0.85",
        "penwidth": "1.4",
        **extra,
    }


def _safe(text: str) -> str:
    """Sanitize text for Graphviz HTML label content (<...>).
    - \\n   -> <BR/>    newlines break the DOT parser when inside HTML label text
    - ->   -> -&gt;    Graphviz 15 parses -> as edge operator even inside <...>
                       &gt; is a supported HTML entity and renders as '>'
    """
    return text.replace("\n", "<BR/>").replace("->", "-&gt;")


def hl(title: str, subtitle: str = "", subtitle2: str = "") -> str:
    """HTML label: bold title + optional smaller subtitle lines."""
    s = f"<B>{_safe(title)}</B>"
    if subtitle:
        s += f'<BR/><FONT POINT-SIZE="9" COLOR="{T_MED}">{_safe(subtitle)}</FONT>'
    if subtitle2:
        s += f'<BR/><FONT POINT-SIZE="9" COLOR="{T_MED}">{_safe(subtitle2)}</FONT>'
    return f"<{s}>"
