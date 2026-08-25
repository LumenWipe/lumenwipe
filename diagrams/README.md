# Diagrams

Source of truth for every diagram in the docs and the root README.

| Folder      | Contents                                                                 | Wired to generation? |
| ----------- | ------------------------------------------------------------------------- | --------------------- |
| `generator/` | Python + Graphviz scripts, one per diagram (`01-system-architecture.py` ... `09-mediator-flow.py`), plus `_style.py` (shared styling) and `render-all.py` (runs all of them) | Yes - this is what produces the rendered output |
| `mmd/`       | Mermaid (`.mmd`) sources, one per diagram, same numbering                | No - kept only as quick-reference context, not part of the render pipeline |

## Regenerating diagrams

```bash
python diagrams/generator/render-all.py   # from repo root
```

Requires Python 3 and Graphviz (`dot`) installed. Output goes to `docs/diagrams/output/` (SVG + PNG) - that location doesn't change, because `docs/architecture.md` and the root `README.md` embed those files with relative paths, and `docs/` is also the Mintlify site source (docs.lumenwipe.com).

To change a diagram, edit the corresponding script in `generator/`, then re-run `render-all.py` and commit the updated SVG/PNG in `docs/diagrams/output/` alongside your script change.

## About `mmd/`

These Mermaid files are not regenerated and not consumed by anything - they exist purely as a lightweight, text-only description of the same diagrams for quick reading or as context for AI tooling. If a diagram changes, update the Graphviz script (source of truth) and optionally the matching `.mmd` file; nothing breaks if they drift, but try to keep them roughly in sync.

| # | Diagram | Section |
| --- | --- | --- |
| 1 | system-architecture | Three-layer architecture: browser trust boundary (verify + sign), API service (builds transactions), Stellar network |
| 2 | data-flow | Enumerate, API re-reads live via RPC and builds the plan, browser verifies and signs, submit via API |
| 3 | state-machine | Demolish flow state machine (Idle → Analyzing → Executing → Complete) |
| 4 | signing-flow | API-built envelope, verify(), wallet or secret key, submit via API, poll |
| 5 | defi-adapter-fallback | DeFi position adapter: OctoPos, freshness gate, degraded mode |
| 6 | execution-plan | Ordered 9-step demolish execution plan |
| 7 | blend-unwind | Blend unwind: repay debt, withdraw supply, backstop Q4W |
| 8 | asset-conversion-routing | Soroswap Aggregator with SDEX fallback |
| 9 | mediator-flow | Mediator account flow for exchange destinations (no ACCOUNT_MERGE support) |
