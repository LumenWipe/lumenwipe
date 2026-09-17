# SCF Build Submission Draft - LumenWipe

> Mirrors the "SCF Award - Submission Form" field by field. Copy each block into its field.
> `[DRAFT NOTE: ...]` items need a team decision or verification before submitting.
> Rich-text fields (Products & Services, Traction Evidence, Team Description, Tranche Deliverables) accept links and lists: paste links directly instead of the `[EMBED: ...]` convention.
>
> Round: SCF #44, deadline **June 14, 2026**. Payout: 10% on approval, then 20/30/40 per tranche. Security audit via Audit Bank (no grant cost). Tranche dates assume award acceptance early August 2026 - adjust proportionally if the actual date differs.

---

## Submission Information

### Project

Pre-selected: **LumenWipe**

### Round

**SCF #44 (June 14, 2026)**

### Build Award Track

**RFP** (the RFP being addressed, Account Demolisher, is named in the Submission Title and the first line of Products & Services)

### Submission Title

```
LumenWipe - Account Demolisher
```

### Project Type

**Developer Tool**

### Project URL

```
https://lumenwipe.com
```

---

## Technical Architecture Document

```
https://docs.lumenwipe.com/architecture
```

The form warns: must be accessible, Stellar-specific, and for RFP track must include detailed planned Stellar integration. The doc qualifies: 25 sections, 9 Mermaid diagrams, and the data-source, RPC, and protocol-integration detail is its core.

[REMINDER before submitting: verify the link is accessible logged out and on mobile.]

### GitHub URL

```
https://github.com/LumenWipe/lumenwipe
```

### Video URL

```
https://youtu.be/vD3xhPpqah8
```

---

## Products & Services

> Form guidance: succinct; for each feature, how Stellar is used and how the improvement impacts the project.

```
This submission responds to the Account Demolisher RFP. LumenWipe is built by a two-time SCF Build Award team with a classic account wind-down already live on mainnet; this award funds Soroban and DeFi parity, the REST API and SDK, and production hardening.

We studied stellar.expert/demolisher (Orbit Lens) in depth before building - its step-ordering logic informed our architecture. LumenWipe extends it with full Soroban support, five DeFi protocol exits, sponsored fees for reserve-locked accounts, and an API/SDK layer the existing tool lacks.

What this submission delivers:

- Claimable balances and per-asset dispositions. User-selected claiming with predicate and sponsorship handling; per-asset choice of convert, transfer, or burn before ChangeTrust removal.
- DeFi position exits: Blend, Aquarius, Soroswap, Phoenix, and FxDAO - two protocols beyond the RFP minimum. Positions sourced from OctoPos or Orion for mainnet reads; direct getLedgerEntries as testnet and fallback path. Every exit built client-side as an InvokeHostFunction and simulated via simulateTransaction before signing.
- Soroban token conversion. SEP-41 balances swap to XLM or a user-specified base asset through the Soroswap API; API-built XDR verified client-side before signing.
- Allowance inspector. SEP-41 allowance discovery via getEvents and a known-contract registry; one-click revocation without closing the account.
- Sponsored fees. CAP-15 fee-bump envelopes for accounts locked at minimum reserve - the accounts that need this tool most.
- Exchange-safe merges. CEX merges run through a shared mediator in one atomic transaction - a deliberate improvement over the RFP's temporary mediator: reserve paid once by the operator, so the user recovers essentially all XLM. Memo type enforced from an open-source exchange registry.
- REST API and TypeScript SDK. Programmatic wind-down for wallets and platforms; first integration partner Pollar has a signed LOI.

Signing layer: stellar-wallets-kit (SEP-43), in-memory secret key mode, and multi-key multisig gathering. Secret keys never reach a server.

Dry-run approach: a full deterministic plan is computed from live account state before any transaction is built - the user sees every step before signing anything. Each transaction is then simulated via simulateTransaction immediately before the signing prompt. For most accounts the multi-step nature makes a single atomic dry-run impractical; this two-layer model provides equivalent safety guarantees.

Maintenance: Apache 2.0 open source; integration partnerships (Pollar LOI is the first) sustain ongoing development; volume API/SDK usage carries a small fee, keeping the tool free for individual users; the static frontend and serverless read-only API keep operating costs minimal; the wasmHash contract registry means adding a new protocol version is a registry update, not a code change.

Decentralization: all transactions built and signed in the browser; the server has no path to user keys or funds. The only centralized components are two narrow backend keys (mediator co-sign, fee-bump sponsor) whose blast radius is structurally bounded - neither can initiate a transaction or redirect funds. The exchange registry is open-source and self-hostable.

Infrastructure: static Next.js frontend on Vercel CDN; serverless read-only API routes using Stellar RPC (simulation, submission, live reads) and Horizon (offers, full account state, classic path-finding), plus the mediator co-sign endpoint; Vercel KV for a single merge-count integer. No databases, no user data at rest.

Privacy: fully non-custodial - no wallet addresses, account states, or transaction details stored server-side. The fee-bump endpoint applies per-IP rate limiting for abuse prevention; IPs are not logged or retained.

Community updates: monthly updates in the LumenWipe Matrix room (https://matrix.to/#/#lumenwipe:matrix.org), Discord (https://discord.gg/edcYRDSQ), and the LumenWipe blog, covering tranche progress, blockers, and on-chain evidence.

Licensing: Apache 2.0. Full repository: https://github.com/LumenWipe/lumenwipe.
```

---

## Traction Evidence

> Form guidance: transaction links, dashboards, social media, signed contracts or LOIs with confidential information redacted.

```
Signed LOI with Pollar (https://pollar.xyz/) - an SDK for onboarding users and enabling payments on Stellar - to integrate LumenWipe into its account closure path, recovering XLM back to the master account that funded each user wallet. Publicly available, business terms redacted: https://drive.google.com/file/d/1VrRXZOwgN51TRduPM2lzI9Hbz5ooDovF/view?usp=share_link

Launched less than two weeks ago. Since launch: 10+ accounts closed on mainnet with 100+ XLM in base reserves recovered; 50+ accounts closed on testnet; 300+ unique visitors. Example end-to-end mainnet closure: https://stellar.expert/explorer/public/tx/270677660857139200. Public analytics: https://cloud.umami.is/analytics/us/share/CoZOq3AqwlmvKs93?date=6month&page=1

Open-source codebase, Apache 2.0: https://github.com/LumenWipe/lumenwipe - deterministic plan builder, step executor with per-step confirmation, IndexedDB session recovery reconciled against on-chain state, exchange registry with memo enforcement, the mediator flow, unit tests, and Playwright end-to-end tests against testnet: https://stellar.expert/explorer/testnet/account/GALYU2WHUH5HV3BAYTOP5ZMUJWXF43QLSVFTEMBYCWF6MM5JDFHXFESQ

Documentation: https://docs.lumenwipe.com

Community: Matrix https://matrix.to/#/#lumenwipe:matrix.org · Discord https://discord.gg/edcYRDSQ
```

---

## Resubmission Feedback

Leave blank (first-time submission).

## Ambassador Affiliation

```
Both team members are active Stellar Ambassadors, Colombia chapter, contributing through community support, mentorship, and collaboration with local ecosystem builders.
```

## Thumbnail

16:9, 1920x1080 - attached.

## Team Members

Add both team members' SCF accounts (each person needs an account on the submission platform before they can be added, per the field's note).

## Team Description

> The form pre-fills this field with the interest form text. Replace with the version below (same base, adds delivery record and security posture, which the RFP weighs).

```
We are a team of two software engineers and active Stellar Ambassadors with a proven track record building dev tools and end-user apps on Stellar.

Sebastian Salazar - Ecosystem Engineering Lead
LinkedIn: https://www.linkedin.com/in/sebastian-salazar-solano/ | GitHub: https://github.com/salazarsebas
Founder of Acachete Labs and former Stellar Fellow at OnlyDust, Sebastian builds open-source developer tooling for Stellar and ZK cryptography. Projects include Akkuea (https://github.com/akkuea/akkuea, real-world asset infrastructure on Stellar: 230+ forks, 200+ contributors) and Cougr (https://github.com/salazarsebas/Cougr, ECS framework for on-chain games: 40+ forks, 130+ crate downloads), both featured on Drips. He won the ETH Pura Vida hackathon with Revolutionary Farmers, reaching 60+ contributors per repository. On LumenWipe, Sebastian leads the DeFi protocol adapters, the REST API and TypeScript SDK, and ecosystem integrations.

Miguel Nieto - Core Systems Lead
LinkedIn: https://www.linkedin.com/in/miguelnietoa/ | GitHub: https://github.com/miguelnietoa
Senior Software Engineer and two-time SCF Build Award recipient, with both prior awards fully delivered. He helped build the Elixir Stellar SDK (https://github.com/kommitters/stellar_sdk, 15k+ downloads), production code whose entire job is key handling, transaction construction, and signing, the same security surface this tool lives on. He co-built Chaincerts (https://github.com/kommitters/chaincerts-smart-contracts, decentralized identity and verifiable credentials on Soroban) and soroban-did-contract (https://github.com/kommitters/soroban-did-contract), plus Tippa (https://github.com/TryTippa, cascading donations on Stellar) and StellarView (https://github.com/salazarsebas/stellar-explorer). On LumenWipe, Miguel leads the transaction construction layer, signing infrastructure, and all security-critical paths.

Security posture, because this tool drains accounts and the RFP weighs audit history: the codebase runs internal security reviews on every change to key handling, transaction construction, and the mediator flow; security-sensitive PRs are flagged and double-reviewed by policy (see CONTRIBUTING.md). Tranche 2 produces an adversarial test suite and a STRIDE threat model, and we commit to an independent security review with remediation before mainnet launch; we apply to the SDF Audit Bank and take that route if selected. The non-custodial design bounds the blast radius structurally: there is no server-side path to user keys or user funds to attack.
```

---

## SCF Build Tranche Deliverables

> Total ask: **$120,000**. Payout: T0 $12,000 (10%, on approval), T1 $24,000 (20%), T2 $36,000 (30%), T3 $48,000 (40%).
> Bottom-up basis: 2 senior engineers at $2,500/week (within benchmark for senior full-stack and protocol work), with each deliverable budgeted from its estimated effort. No marketing, no audit fees (covered by the SDF Audit Bank), no legal costs, no contingency.
> Dates assume award acceptance in early August 2026; shift all three by the actual date. The form mentions ~4 months as typical; this plan takes ~5.5 months because it integrates five DeFi protocols across two tranches and ships an API and SDK on top of the core tool, within the handbook's 6-month limit.
> Per the form's suggested format, each deliverable lists: brief description, how to measure completion, budget.

### Tranche #1 Deliverables

```
Tranche 1 - Classic completion (MVP). Total: $24,000.

T1 closes the classic account closure path end to end - the only path executable without DeFi protocol risk in the MVP phase, so it can be independently verified before Soroban and DeFi complexity is layered in T2. The working classic wind-down (live on mainnet, see Traction Evidence) is the starting point, not a deliverable; every item below is future work.

1. Claimable balances, end to end
- Brief description: Enumerate claimable balances (claim predicates and sponsorship implications included), user-selected claiming in the plan, ClaimClaimableBalance execution, and created-balance sponsorships detected as merge blockers.
- How to measure completion: On testnet, an account holding claimable balances closes end to end with selected balances claimed; an account sponsoring a claimable balance is blocked with a plain-language explanation. Reproducible via the public E2E suite.
- Budget: $7,500

2. Per-asset dispositions
- Brief description: Per-asset choice of convert, transfer as-is to a destination holding the trustline, or burn to issuer - applied before ChangeTrust removal for each non-XLM balance in the plan.
- How to measure completion: Testnet close where one asset converts, one transfers, and one burns, each confirmed independently; the E2E suite covers the three-path scenario.
- Budget: $5,500

3. Account state provider
- Brief description: Pluggable Horizon-compatible provider for offer and data-entry enumeration, with numSubEntries reconciliation as the completeness check - a mismatch between indexed count and on-chain count surfaces a plan-build blocker instead of producing a silent incomplete plan.
- How to measure completion: A testnet account whose indexed subentry count diverges from the live numSubEntries value demonstrably surfaces a blocker rather than proceeding; provider is swappable without code changes, verified by an integration test that stubs the provider.
- Budget: $4,500

4. Multisig hardening
- Brief description: Signature gathering across several wallets and keys on one envelope, covering ed25519 signers, with hash(x) and pre-auth signer types surfaced with manual-path guidance.
- How to measure completion: A 2-of-3 multisig account closed on testnet using two different wallets in a recorded demo; the E2E suite covers the multisig path.
- Budget: $6,500
```

### Tranche #1 Completion Date

```
15/09/2026
```

### Tranche #2 Deliverables

```
Tranche 2 - Soroban and DeFi parity (Testnet). Total: $36,000.

1. DeFi position detection via OctoPos or Orion, with testnet fallback
- Brief description: Adapter over OctoPos or Orion (both funded DeFi Position API recipients) normalizing positions across protocols, freshness metadata, and partial-result flags. The primary provider for mainnet reads is selected based on readiness at integration time; direct contract reads via getLedgerEntries serve as the testnet path, keeping degraded-mode coverage under permanent CI.
- How to measure completion: Positions for a seeded account detected on mainnet via the selected provider; the same account shape detected on testnet via direct contract reads; provider outage demonstrably degrades to classic-only flow with a plain-language warning.
- Budget: $5,000

2. Protocol exit adapters: Blend, Aquarius, Soroswap
- Brief description: Per-protocol exits built client-side - Blend via @blend-capital/blend-sdk Pool.submit with repay-before-withdraw and health factor checks; Aquarius withdraw and claim; Soroswap remove_liquidity with client-side verification of API-built XDR - all behind a versioned wasmHash contract registry, satisfying the exit adapter invariants (live re-read, simulate before sign, clamp to balance, minimum-received bounds, no silent skips).
- How to measure completion: For each of the three protocols, a testnet account with an open position closes end to end; integration tests per protocol run in CI; an unknown wasmHash flags for manual review instead of building an exit.
- Budget: $12,000

3. Soroban conversion, allowance inspector, sponsored fees
- Brief description: Soroban token conversion through the Soroswap API (routing across the Soroswap Aggregator and the classic SDEX, with Stellar RPC as the live state source and Horizon for SDEX path-finding) with user-specified base asset support; the read-only allowance inspector (SEP-41 allowance discovery via getEvents plus a known-contract registry, one-click revocation); the CAP-15 fee-bump endpoint with shape validation, per-transaction fee caps, and rate limiting, so reserve-locked accounts can close.
- How to measure completion: A testnet account holding only Soroban tokens converts and closes; allowances listed and revoked on testnet; an account at exactly its minimum balance closes end to end with sponsored fees.
- Budget: $10,000

4. Adversarial test suite and threat model
- Brief description: Adversarial and edge-case test suite over hostile account states (sponsoring accounts, the 1000-subentry maximum, revoked trustlines, hash(x) and pre-auth signers, undercollateralized vaults, queued backstop withdrawals, lost confirmation responses); a written STRIDE threat model covering key handling, the two backend signing keys, transaction construction, and the session layer; a security tooling run with a remediation plan for critical, high, and medium findings.
- How to measure completion: Adversarial suite running in CI; threat model and tooling results with remediation plan published in the repository.
- Budget: $9,000
```

### Tranche #2 Completion Date

```
15/11/2026
```

### Tranche #3 Deliverables

```
Tranche 3 - Production launch (Mainnet). Total: $48,000.

1. Security hardening and mainnet launch
- Brief description: Pre-launch security hardening across the signing paths, the mediator, and the fee-bump surface - the critical paths that handle user funds. This includes an independent security review through the SDF Audit Bank. All critical and high findings are resolved before launch. Mainnet deployment with CSP enforced (no unsafe-eval, no inline scripts), production monitoring, and alerting.
- How to measure completion: Independent security review complete with all critical and high findings resolved and documented; full wind-down including one DeFi exit executed on mainnet on the team's own account, linked from the explorer; production app live at lumenwipe.com with CSP and monitoring confirmed.
- Budget: $20,000

2. Phoenix and FxDAO protocol exits
- Brief description: Exit adapters for Phoenix (withdraw_liquidity with unbond) and FxDAO (pay_debt plus collateral withdrawal), behind the same versioned wasmHash contract registry and satisfying the same exit adapter invariants as the T2 protocols. Shipped after security remediation so audit coverage applies to all five protocols at mainnet launch.
- How to measure completion: For each protocol, a testnet account with an open position closes end to end; integration tests run in CI; mainnet exit demonstrated on the team's own account, linked from the explorer.
- Budget: $6,000

3. Public REST API and TypeScript SDK
- Brief description: Read-only REST API (batch account analysis, per-step unsigned XDR generation) and the transaction builder published as a typed npm package, so wallets and platforms embed the wind-down with their own signers. Reference integration path for the signed Pollar partnership.
- How to measure completion: npm package published; API documented; an integration example closes a testnet account driven entirely through the SDK without the web UI.
- Budget: $14,000

4. Production UX and documentation
- Brief description: UX pass from moderated user testing of the irreversible-action flows (plan review, confirmations, failure recovery), plain-language error coverage, and complete public documentation including API and SDK integration guides.
- How to measure completion: Five recorded user-testing sessions with findings addressed; docs site covers the user flow, the REST API, and the SDK integration guide; all UI errors human-readable (no raw SDK codes), verified by the E2E suite.
- Budget: $8,000
```

### Tranche #3 Completion Date

```
15/01/2027
```

---

## Legal Acknowledgements

Checkboxes, internal use only: Official Rules and Terms, Restrictions on Use of Funds, Sanctions Compliance, Disclaimers and Limitations, General Conditions. All must be checked to submit; read them once, no content to prepare.

---

---

# Appendix - supporting material with no form field (delete before submitting)

The form has no field for these, but reviewers may raise them in the review meeting, and parts already live in the linked docs (architecture §13-§16, community page, use cases). Keep at hand.

## RFP requirement coverage map

Every core requirement of the RFP maps to a section of the published architecture (docs.lumenwipe.com/architecture):

- Sponsorship check: pre-flight detects numSponsoring > 0 and blocks the merge with an explanation (§3).
- Multisig detection and signer normalization: thresholds and signers read live; extra signers removed with SetOptions, thresholds set to 0/1/1 (§8).
- Trustlines, data entries, offers: enumerated via indexer, re-read live over RPC, removed in dependency order, batched at the 100-op limit (§8, §9.1).
- Claimable balances: optional, user-selected claims (§8).
- Open positions: classic DEX offers, classic AMM LPs, and DeFi positions across Blend, Aquarius, Soroswap, Phoenix, and FxDAO, two protocols beyond the RFP's named minimum (§9).
- Sell all tokens to a target base asset: XLM by default or user-specified, via the Soroswap API, with Horizon-compatible SDEX path finding as fallback; per-asset convert/transfer/burn dispositions (§10).
- Merge with exchange support: shared, operator-funded mediator instead of the RFP's temporary mediator, a deliberate improvement (reserve paid once, user recovers essentially all XLM); registry-enforced memos (§11).
- Allowance inspector (§12). Soroban parity including state-archival restoration (§9, §22).
- stellar-wallets-kit plus secret key input, multi-key multisig (§6.3).
- Trust minimization: client-side signing; backend read-only except two narrow keys that cannot touch user funds (§13, §14).
- Dry-run approach (the RFP explicitly asks for the proposer's approach): full plan view up front plus per-step simulation immediately before each signature; failures surface in plain language before signing (§8).
- Open source Apache 2.0; production-grade UX for irreversible actions (§13.3, §16).

## Integration plan (lives in docs/use-cases, summarized)

Three surfaces, each a documented use case (docs.lumenwipe.com/use-cases): the guided UI for individuals (live today for the classic flow); the REST API for fleet decommissioning and exchange off-boarding (batch analysis, per-step XDR, registry-encoded memo rules); the TypeScript SDK for wallets and embedded platforms, where Pollar has a signed LOI to integrate LumenWipe into its account closure path. Coordination during development: OctoPos, the five protocol teams, Orbit Lens / stellar.expert, and the stellar-wallets-kit maintainers.

## Budget basis (bottom-up)

2 senior engineers, 24 weeks, $2,500/week each = $120,000 total including T0. Per-deliverable budgets in the tranche fields derive from estimated effort at that rate (e.g., $7,500 = 3 dev-weeks); keep this mapping at hand for the reviewer meeting even though the form fields state only the dollar amounts.

Benchmarks (June 2026, from communityfund.stellar.org data): $120K is the median of all 11 RFP-track awards to date; both DeFi Positions API RFP winners landed there with 2-3 person teams (OctoPos $120,000, Orion $122,221), and cheaper rival bids on that same RFP ($50K-$105K) lost. Full-scope RFP awards run $80K-$150K; per named team member the observed band is $25K-$60K, and this ask sits at $60K/person, the same point as OctoPos. Recent Developer Tooling awards (rounds 38-42) also median $120K. Competing asks on this RFP this round: $117K and $120K.

---

# Pre-submit checklist (delete before submitting)

- [x] Pitch video URL - https://youtu.be/vD3xhPpqah8
- [x] Thumbnail - attached
- [x] Pollar LOI - Google Drive link confirmed publicly accessible
- [x] Ambassador Affiliation - Colombia chapter, filled
- [x] Both team members added to SCF platform (both hold Pathfinder role)
- [x] All links verified working while logged out (docs.lumenwipe.com/architecture ✓, GitHub, analytics link)
- [x] Discord invite - https://discord.gg/edcYRDSQ
- [x] Submission title - "LumenWipe - Account Demolisher"
- [x] Budget total - $120K, tranche split 10/20/30/40 correct
- [ ] Tranche dates - adjust if actual award date differs from early August 2026 (current: 15/09, 15/11, 15/01)
- [x] Legal acknowledgements - read and checked
- [x] RFP Track requirements in Products & Services: maintenance, decentralization, infrastructure, privacy, community updates, licensing, stellar.expert/demolisher reference, dry-run approach
- [x] Audit cost removed from T3 - Audit Bank covers the audit; T3 D1 budget covers only remediation engineering + deploy
- [NOTE: Miguel's bio claim "two-time SCF Build Award recipient, with both prior awards fully delivered" is intentional and the team takes full responsibility for its accuracy. Not to be modified.]
