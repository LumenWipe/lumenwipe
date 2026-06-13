---
title: "Community and maintenance"
sidebarTitle: "Community"
description: "Building in the open, update cadence, decentralized channels, and post-launch maintenance."
icon: "people-group"
---

Companion to the [technical architecture](/architecture). This document covers how the project builds in the open, how it keeps the community updated, where it maintains a presence (including decentralized networks), and how it is maintained after launch.

## 1. Building in the open

LumenWipe is open source under Apache 2.0 from the start, not after a private build phase. That means a permissive license, a public repository, a public issue tracker, and a public roadmap. The reference tool this project extends, [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public) by Orbit Lens, is itself open, and this project keeps that spirit: the full frontend, the read-only backend, the transaction construction layer, the contract registry, and the test suite are public.

Anyone can read the code, file an issue, or propose a change. Because the tool performs irreversible actions on real accounts, openness is also a security property: the more eyes on the signing and transaction-construction code, the better.

## 2. Licensing

- License: Apache 2.0 (permissive, allows reuse, includes a patent grant).
- Attribution: the project credits and builds upon the public-domain work of [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public).
- Dependencies: dependencies are tracked and their licenses are compatible with Apache 2.0.

## 3. Community updates

The project commits to a regular, public update rhythm so the community can follow progress.

- Per tranche: a written milestone update when each tranche's acceptance criteria are met, posted publicly and linked from the repository.
- Monthly: a short progress note covering what shipped, what is in flight, and any blockers.
- Continuous: a public changelog and release notes on each release, and an open issue tracker and roadmap.
- Protocol-coverage review: a periodic note on which DeFi protocol versions are covered and which were added, since DeFi contracts change over time.

## 4. Where the project communicates

The project maintains a presence across both standard ecosystem channels and decentralized, open networks.

| Channel           | Type                       | Use                                                                                                                 |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GitHub            | Open source                | Code, issues, roadmap, releases, changelog. The primary source of truth.                                            |
| LumenWipe Discord | Community                  | Community chat, user support, and project discussion. Invite: https://discord.gg/b37CPB7g                           |
| Matrix            | Decentralized, open source | A public room for project discussion, bridged where useful. Open-protocol, self-hostable, no single platform owner. |
| Telegram          | Community                  | Real-time community chat, user support, and announcements.                                                          |

The reasoning behind the decentralized channels is consistency with the project's own values. A non-custodial, open-source tool should not anchor its public communication to a single proprietary platform. Matrix is an open protocol that no single company controls, which matches the tool's design and reduces single-platform risk for the community that depends on it.

## 5. Coordination with protocol and ecosystem teams

Closing positions correctly depends on each DeFi protocol's contract interfaces, which change. The project coordinates with the relevant teams during development and after launch:

- The DeFi Position API provider, OctoPos, since the backend consumes it and the tool relies on accurate position detection.
- The DeFi protocol teams whose positions the tool unwinds: Blend, Aquarius, Soroswap, Phoenix, and FxDAO, to track contract upgrades and confirm exit interfaces.
- Orbit Lens and the stellar.expert team, whose demolisher this project extends and whose API the tool reads for enumeration.
- The stellar-wallets-kit maintainers, for wallet integration and Soroban authorization-entry signing.

## 6. Maintenance after launch

The architecture is built so that the parts most likely to change are the parts cheapest to update.

- Versioned contract registry. Each pool or vault contract's `wasmHash` maps to a known protocol version. A new protocol version is a reviewed pull request to the registry, not a code change. An unknown `wasmHash` flags the affected position for manual review rather than risking a wrong exit transaction.
- Adapter isolation. Each DeFi protocol and each data provider sits behind an adapter, so adding a protocol or swapping a provider is a contained change.
- Dependency hygiene. Dependencies are pinned, audited in CI, and updated through weekly pull requests. No dependency that needs dynamic code execution is permitted.
- Security process. The repository carries a security policy and a responsible-disclosure process, with a contact for reporting vulnerabilities and a disclosure window.
- Coverage cadence. DeFi protocol coverage is reviewed periodically, and new protocols supported by the DeFi Position API are evaluated for inclusion.

## 7. Post-launch commitments

- Critical security issues are patched on a short, published timeline after disclosure.
- The contract registry is updated promptly after a supported protocol deploys a new version.
- The repository accepts community contributions under published contribution guidelines.
- The community update rhythm in section 3 continues past the funded tranches.
