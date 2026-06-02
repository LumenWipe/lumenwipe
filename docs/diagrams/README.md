# Diagram sources

Mermaid sources for every diagram in the [architecture document](../architecture.md). They are duplicated here as standalone `.mmd` files so they can be exported to Whimsical, Excalidraw, or image formats without copying them out of the prose. The architecture document already renders these inline on GitHub and GitBook, so these files are for polishing and export, not for reading.

| File | Diagram | Section in architecture.md |
|---|---|---|
| [01-system-architecture.mmd](./01-system-architecture.mmd) | System architecture: client, read-only backend, network, trust boundary | §4 |
| [02-data-flow.mmd](./02-data-flow.mmd) | Data flow: enumerate via indexer, re-read live via RPC, build plan | §5 |
| [03-state-machine.mmd](./03-state-machine.mmd) | Demolish flow state machine | §6.1 |
| [04-signing-flow.mmd](./04-signing-flow.mmd) | Signing flow: wallet or secret key, review, submit, poll | §6.3 |
| [05-defi-adapter-fallback.mmd](./05-defi-adapter-fallback.mmd) | DeFi position adapter: OctoPos to Orion to degraded mode | §7.1 |
| [06-execution-plan.mmd](./06-execution-plan.mmd) | Ordered demolish execution plan | §8 |
| [07-blend-unwind.mmd](./07-blend-unwind.mmd) | Blend unwind: repay, withdraw, backstop Q4W | §9.3 |
| [08-asset-conversion-routing.mmd](./08-asset-conversion-routing.mmd) | Asset conversion and routing | §10 |
| [09-mediator-flow.mmd](./09-mediator-flow.mmd) | Mediator account flow for exchange destinations | §11 |

## Rendering and export

- Quick preview or PNG/SVG export: paste a file into the [Mermaid Live Editor](https://mermaid.live).
- Local image export: `npx -y @mermaid-js/mermaid-cli -i docs/diagrams/01-system-architecture.mmd -o 01-system-architecture.svg`.
- Whimsical or a custom visual style: feed the natural-language description (or the Mermaid source) to the Cocoon-AI architecture-diagram-generator, or recreate in the Excalidraw MCP.

Keep these in sync with the inline diagrams in `architecture.md`. The inline copies are the source of truth for the hosted document; these standalone files are derived from them.
