# Diagram sources

Mermaid sources for every diagram in the [architecture document](../architecture.md), with rendered PNG and SVG exports in [`output/`](./output/).

The architecture document embeds the SVG exports directly. The `.mmd` files here are the authoring source; edit them and re-export to update the diagrams. The rendered outputs in `output/` are also referenced by the root [README](../../README.md).

## Diagrams

| #   | File                                                                 | Description                                                                          | Section |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- |
| 1   | [01-system-architecture.mmd](./01-system-architecture.mmd)           | Three-layer architecture: browser trust boundary, read-only backend, Stellar network | §4      |
| 2   | [02-data-flow.mmd](./02-data-flow.mmd)                               | Data flow: enumerate via indexer, re-read live via RPC, build plan                   | §5      |
| 3   | [03-state-machine.mmd](./03-state-machine.mmd)                       | Demolish flow state machine (Idle → Analyzing → Executing → Complete)                | §6.1    |
| 4   | [04-signing-flow.mmd](./04-signing-flow.mmd)                         | Signing flow: wallet or secret key, XDR review, submit, poll                         | §6.3    |
| 5   | [05-defi-adapter-fallback.mmd](./05-defi-adapter-fallback.mmd)       | DeFi position adapter: OctoPos, freshness gate, degraded mode                        | §7.1    |
| 6   | [06-execution-plan.mmd](./06-execution-plan.mmd)                     | Ordered 9-step demolish execution plan                                               | §8      |
| 7   | [07-blend-unwind.mmd](./07-blend-unwind.mmd)                         | Blend unwind: repay debt, withdraw supply, backstop Q4W                              | §9.3    |
| 8   | [08-asset-conversion-routing.mmd](./08-asset-conversion-routing.mmd) | Asset conversion routing: Soroswap Aggregator with SDEX fallback                     | §10     |
| 9   | [09-mediator-flow.mmd](./09-mediator-flow.mmd)                       | Mediator account flow for exchange destinations (no ACCOUNT_MERGE support)           | §11     |

## Rendered outputs

All diagrams are exported to [`output/`](./output/) in both SVG and PNG formats. SVGs are vector and preferred for documentation embeds. PNGs are 2× rasterized for use in slide decks or contexts that don't support SVG.

| Diagram                  | SVG                                                                         | PNG                                                                         |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| System architecture      | [01-system-architecture.svg](./output/01-system-architecture.svg)           | [01-system-architecture.png](./output/01-system-architecture.png)           |
| Data flow                | [02-data-flow.svg](./output/02-data-flow.svg)                               | [02-data-flow.png](./output/02-data-flow.png)                               |
| State machine            | [03-state-machine.svg](./output/03-state-machine.svg)                       | [03-state-machine.png](./output/03-state-machine.png)                       |
| Signing flow             | [04-signing-flow.svg](./output/04-signing-flow.svg)                         | [04-signing-flow.png](./output/04-signing-flow.png)                         |
| DeFi adapter fallback    | [05-defi-adapter-fallback.svg](./output/05-defi-adapter-fallback.svg)       | [05-defi-adapter-fallback.png](./output/05-defi-adapter-fallback.png)       |
| Execution plan           | [06-execution-plan.svg](./output/06-execution-plan.svg)                     | [06-execution-plan.png](./output/06-execution-plan.png)                     |
| Blend unwind             | [07-blend-unwind.svg](./output/07-blend-unwind.svg)                         | [07-blend-unwind.png](./output/07-blend-unwind.png)                         |
| Asset conversion routing | [08-asset-conversion-routing.svg](./output/08-asset-conversion-routing.svg) | [08-asset-conversion-routing.png](./output/08-asset-conversion-routing.png) |
| Mediator flow            | [09-mediator-flow.svg](./output/09-mediator-flow.svg)                       | [09-mediator-flow.png](./output/09-mediator-flow.png)                       |

## Keeping diagrams in sync

The `.mmd` files here are the source of truth. `architecture.md` embeds the pre-rendered SVGs from `output/`. When updating a diagram:

1. Edit the corresponding `.mmd` file here.
2. Re-export the SVG and PNG to `output/` (see below).
3. The updated SVG is picked up automatically by `architecture.md` on the next build.

## Export

```bash
# Single diagram to SVG
npx -y @mermaid-js/mermaid-cli -i docs/diagrams/01-system-architecture.mmd -o docs/diagrams/output/01-system-architecture.svg

# All diagrams (requires @mermaid-js/mermaid-cli installed globally or via npx)
for f in docs/diagrams/*.mmd; do
  name=$(basename "$f" .mmd)
  npx @mermaid-js/mermaid-cli -i "$f" -o "docs/diagrams/output/${name}.svg"
  npx @mermaid-js/mermaid-cli -i "$f" -o "docs/diagrams/output/${name}.png"
done
```

For interactive editing and quick preview, paste any `.mmd` file into the [Mermaid Live Editor](https://mermaid.live).
