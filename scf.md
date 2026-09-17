# SCF Build Submission Draft — LumenWipe

> Mirrors the "SCF Award - Submission Form" field by field. Copy each block into its field.
> `[DRAFT NOTE: ...]` items need a team decision or verification before submitting.
> Rich-text fields (Products & Services, Traction Evidence, Team Description, Tranche Deliverables) accept links and lists: paste links directly instead of the `[EMBED: ...]` convention.
>
> Round: SCF #44, deadline **June 14, 2026**. Payout: 10% on approval, then 20/30/40 per tranche. Tranche #3 completion includes professional user testing and the security audit credits (per the form's own notes).

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

[DRAFT NOTE: the form wants a unique title, different from the project name, reflecting what the funding is for. This one names the RFP and the funded delta. Alternative if you want the product visible: "LumenWipe: the Account Demolisher RFP, Soroban-complete".]

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

[DRAFT NOTE: open the link logged out and on mobile before submitting. Reviewers reject inaccessible or generic docs.]

### GitHub URL

```
https://github.com/LumenWipe/lumenwipe
```

### Video URL

```
[TODO: record and upload]
```

[DRAFT NOTE: **this does not exist yet and the deadline is June 14.** Under 3 minutes, YouTube or Vimeo, 16:9 (1920x1080). Strongest possible script with what is already live: open lumenwipe.com/mainnet, analyze a real account, show the deterministic plan, execute a step with a wallet confirmation, show the merge tx on stellar.expert, close with the Soroban/DeFi roadmap and the Pollar integration. A screen recording with voiceover beats slides.]

---

## Products & Services

> Form guidance: succinct; for each feature, how Stellar is used and how the improvement impacts the project.

```
This submission responds to the Account Demolisher RFP. LumenWipe cleanly closes a Stellar account and returns its locked XLM reserves. The classic wind-down already runs on testnet and mainnet; this award funds the remaining classic steps, full Soroban and DeFi parity, and production hardening. What this submission adds:

- Claimable balances and per-asset dispositions. ClaimClaimableBalance steps for user-selected balances, and a per-asset choice of convert, transfer, or burn before ChangeTrust removal. Completes the classic wind-down so any classic account closes end to end.

- DeFi position exits across Blend, Aquarius, Soroswap, Phoenix, and FxDAO. Positions detected via OctoPos (a funded DeFi Position API recipient); every exit built client-side as an InvokeHostFunction operation against live getLedgerEntries reads and simulated via simulateTransaction before signing. This is the capability no existing tool has: an account with a Blend loan or an Aquarius LP position cannot be closed by anything today.

- Soroban asset conversion. SEP-41 token balances swap to XLM or a user-chosen base asset through the Soroswap API, which routes across the Soroswap Aggregator and the classic SDEX, with server-built XDR decoded and verified client-side before signing.

- Allowance inspector. Reads SEP-41 allowances with spender discovery via RPC getEvents and a known-contract registry; one-click revocation. Lets users secure funds after allowance-based DeFi exploits without closing the account.

- Sponsored fees. CAP-15 fee-bump envelopes, so an account locked at its minimum reserve, which cannot pay its own transaction fee, can still close. These are the accounts that need the tool most.

- Exchange-safe merges. No major CEX supports ACCOUNT_MERGE, so merges to exchanges run through a shared mediator account in one atomic transaction, with memo type enforced from an exchange registry. The user recovers essentially all of their XLM.

- REST API and TypeScript SDK. The same wind-down programmatically: wallets embed account closure with their own signer, platforms decommission account fleets via batch analysis. First integration partner signed: Pollar.

Everything signs in the browser through stellar-wallets-kit (SEP-43) or an in-memory secret-key mode with multi-key multisig gathering; secret keys never reach a server. The backend is read-only except two narrow keys (mediator co-sign, fee-bump sponsor) that cannot move user funds.
```

---

## Traction Evidence

> Form guidance: transaction links, dashboards, social media, signed contracts or LOIs with confidential information redacted.

```
Production AccountMerge on mainnet, executed end to end by the deployed app at https://lumenwipe.com/mainnet:
https://stellar.expert/explorer/public/tx/a952a51d475d0d0d4d1c2ac1deb6a2848450f4d3ef539f51f933945c709655f1

Signed LOI with Pollar (https://pollar.xyz/), an SDK for onboarding users and enabling payments on Stellar, to integrate LumenWipe into its account closure path, merging recovered XLM back to the master account that funded each user wallet. [Attach the LOI with confidential information redacted.]

Open-source codebase under Apache 2.0: https://github.com/LumenWipe/lumenwipe — deterministic plan builder, step executor with per-step confirmation, IndexedDB session recovery reconciled against on-chain state, exchange registry with memo enforcement, the mediator flow, unit tests, and Playwright end-to-end tests against testnet (https://stellar.expert/explorer/testnet/account/GALYU2WHUH5HV3BAYTOP5ZMUJWXF43QLSVFTEMBYCWF6MM5JDFHXFESQ).

Documentation site: https://docs.lumenwipe.com. 300+ unique visitors since launch, public analytics: https://cloud.umami.is/analytics/us/share/CoZOq3AqwlmvKs93?date=6month&page=1

Community: Matrix https://matrix.to/#/#lumenwipe:matrix.org and Discord [VERIFY-INVITE].
```

[DRAFT NOTE: the Discord invite differs between the interest form (discord.gg/hYfZGhdEm) and the community doc (discord.gg/b37CPB7g); confirm the live one. Redact and attach the Pollar LOI; the form names LOIs as exactly the evidence it wants.]

---

## Resubmission Feedback

Leave blank (first-time submission).

## Ambassador Affiliation

```
Both team members are active Stellar Ambassadors. [DRAFT NOTE: name the chapter(s)/city and the nature of the affiliation: mentorship, collaboration, or community support, as the field asks.]
```

## Thumbnail

[TODO: 16:9 image. The form calls it "the first thing people see". Use the LumenWipe wordmark from `docs/logo/` over the brand background, 1920x1080.]

## Team Members

Add both team members' SCF accounts (each person needs an account on the submission platform before they can be added, per the field's note).

## Team Description

> The form pre-fills this field with the interest form text. Replace with the version below (same base, adds delivery record and security posture, which the RFP weighs).

```
We are a team of two software engineers and active Stellar Ambassadors with a proven track record building dev tools and end-user apps on Stellar.

Sebastian Salazar (LinkedIn: https://www.linkedin.com/in/sebastian-salazar-solano/ | GitHub: https://github.com/salazarsebas)
Founder of Acachete Labs and former Stellar Fellow at OnlyDust, Sebastian builds open-source developer tooling for Stellar and ZK cryptography. Projects include Akkuea (https://github.com/akkuea/akkuea, real-world asset infrastructure on Stellar: 230+ forks, 200+ contributors) and Cougr (https://github.com/salazarsebas/Cougr, ECS framework for on-chain games: 40+ forks, 130+ crate downloads), both featured on Drips. He won the ETH Pura Vida hackathon with Revolutionary Farmers, reaching 60+ contributors per repository.

Miguel Nieto (LinkedIn: https://www.linkedin.com/in/miguelnietoa/ | GitHub: https://github.com/miguelnietoa)
Senior Software Engineer and two-time SCF Build Award recipient, with both prior awards fully delivered. He helped build the Elixir Stellar SDK (https://github.com/kommitters/stellar_sdk, 15k+ downloads), production code whose entire job is key handling, transaction construction, and signing, the same security surface this tool lives on. He co-built Chaincerts (https://github.com/kommitters/chaincerts-smart-contracts, decentralized identity and verifiable credentials on Soroban) and soroban-did-contract (https://github.com/kommitters/soroban-did-contract), plus Tippa (https://github.com/TryTippa, cascading donations on Stellar) and StellarView (https://github.com/salazarsebas/stellar-explorer).

Security posture, because this tool drains accounts and the RFP weighs audit history: the codebase runs internal security reviews on every change to key handling, transaction construction, and the mediator flow; security-sensitive PRs are flagged and double-reviewed by policy (see CONTRIBUTING.md). Tranche 2 produces an adversarial test suite and a STRIDE threat model, and we commit to an independent security review with remediation before mainnet launch; we apply to the SDF Audit Bank and take that route if selected. The non-custodial design bounds the blast radius structurally: there is no server-side path to user keys or user funds to attack.
```

[DRAFT NOTE: "both prior awards fully delivered" must be accurate (resubmission rules require all tranches completed and paid). Confirm, and name the awarded projects if that strengthens it.]

---

## SCF Build Tranche Deliverables

> Total ask: **$120,000**. Payout: T0 $12,000 (10%, on approval), T1 $24,000 (20%), T2 $36,000 (30%), T3 $48,000 (40%).
> Bottom-up basis: 2 senior engineers at $2,500/week (within benchmark for senior full-stack and protocol work), with each deliverable budgeted from its estimated effort. No marketing, no audit fees (the form itself notes audit credits come with tranche #3 completion), no legal costs, no contingency.
> Dates assume award acceptance in early August 2026; shift all three by the actual date. The form mentions ~4 months as typical; this plan takes ~5.5 months because it integrates five DeFi protocols and ships an API and SDK on top of the core tool, within the handbook's 6-month limit.
> Per the form's suggested format, each deliverable lists: brief description, how to measure completion, budget.

### Tranche #1 Deliverables

```
Tranche 1 — Classic completion (MVP). Total: $24,000.

The working classic wind-down (live on mainnet, see Traction Evidence) is the starting point, not a deliverable; every item below is future work.

1. Claimable balances, end to end
- Brief description: Enumerate claimable balances (claim predicates and sponsorship implications included), user-selected claiming in the plan, ClaimClaimableBalance execution, and created-balance sponsorships detected as merge blockers.
- How to measure completion: On testnet, an account holding claimable balances closes end to end with selected balances claimed; an account sponsoring a claimable balance is blocked with a plain-language explanation. Reproducible via the public E2E suite.
- Budget: $7,500

2. Per-asset dispositions and offer/data-entry provider
- Brief description: Per-asset choice of convert, transfer as-is to a destination holding the trustline, or burn to issuer; plus the pluggable Horizon-compatible current-state provider for offer and data-entry enumeration with numSubEntries reconciliation as the completeness check.
- How to measure completion: Testnet close where one asset converts, one transfers, one burns; an enumeration mismatch demonstrably surfaces a blocker instead of building an incomplete plan.
- Budget: $10,000

3. Multisig hardening
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
Tranche 2 — Soroban and DeFi parity (Testnet). Total: $36,000.

1. DeFi position detection via OctoPos, with degraded mode
- Brief description: Adapter over OctoPos (a funded DeFi Position API recipient) normalizing positions, freshness metadata, and partial-result flags; direct contract-read fallback that doubles as the testnet path, keeping the degraded mode under permanent test coverage.
- How to measure completion: Positions for a seeded account detected on mainnet read-only via OctoPos; the same account shape detected on testnet via contract reads; provider outage demonstrably degrades to classic-only flow with a warning.
- Budget: $5,000

2. Protocol exit adapters: Blend, Aquarius, Soroswap, Phoenix, FxDAO
- Brief description: Per-protocol exits built client-side (Blend via @blend-capital/blend-sdk Pool.submit with repay-before-withdraw and health factor checks; Aquarius withdraw and claim; Soroswap remove_liquidity with client-side verification of API-built XDR; Phoenix withdraw_liquidity with unbond; FxDAO pay_debt plus collateral withdrawal), all behind a versioned wasmHash contract registry, satisfying the published exit adapter invariants (live re-read, simulate before sign, clamp to balance, minimum-received bounds, no silent skips).
- How to measure completion: For each of the five protocols, a testnet account with an open position closes end to end; integration tests per protocol run in CI; an unknown wasmHash flags for manual review instead of building an exit.
- Budget: $17,500

3. Soroban conversion, allowance inspector, sponsored fees
- Brief description: Soroban token conversion through the Soroswap API (routing across the Soroswap Aggregator and the classic SDEX) with user-specified base asset support; the read-only allowance inspector (SEP-41 allowance discovery via getEvents plus registry, one-click revocation); the CAP-15 fee-bump endpoint with shape validation, per-transaction fee caps, and rate limiting, so reserve-locked accounts can close.
- How to measure completion: A testnet account holding only Soroban tokens converts and closes; allowances listed and revoked on testnet; an account at exactly its minimum balance closes end to end with sponsored fees.
- Budget: $8,500

4. Adversarial test suite, threat model, and audit readiness
- Brief description: Adversarial and edge-case test suite over hostile account states (sponsoring accounts, the 1000-subentry maximum, revoked trustlines, hash(x) and pre-auth signers, undercollateralized vaults, queued backstop withdrawals, lost confirmation responses); a written STRIDE threat model covering key handling, the two backend signing keys, transaction construction, and the session layer; a self-service security tooling run with a remediation plan for critical, high, and medium findings. These artifacts double as the Audit Bank's application prerequisites, and we submit that application at this point; selection is SDF's decision, so nothing later in the plan depends on it.
- How to measure completion: Adversarial suite running in CI; threat model and tooling results with remediation plan published in the repository; Audit Bank application submitted, with confirmation shared in the tranche report.
- Budget: $5,000
```

### Tranche #2 Completion Date

```
30/11/2026
```

### Tranche #3 Deliverables

```
Tranche 3 — Production launch (Mainnet). Total: $48,000.

1. Security review, remediation, and mainnet launch
- Brief description: Independent security review over the signing paths, mediator, and fee-bump surfaces, with remediation of findings. The Audit Bank is the preferred route if our Tranche 2 application is selected and scheduled in time; otherwise an external reviewer we engage, so the review does not depend on Audit Bank selection. Mainnet deployment with CSP verified (no unsafe-eval, no inline scripts) and monitoring.
- How to measure completion: Review report and remediation log public; full wind-down including one DeFi exit executed on mainnet by the team on its own account, linked from the explorer; production app live at lumenwipe.com.
- Budget: $20,000

2. Public REST API and TypeScript SDK
- Brief description: Read-only REST API (batch account analysis, per-step unsigned XDR generation) and the transaction builder published as a typed npm package, so wallets and platforms embed the wind-down with their own signers. Reference integration path for the signed Pollar partnership.
- How to measure completion: npm package published; API documented; an integration example closes a testnet account driven entirely through the SDK without the web UI.
- Budget: $15,000

3. Production UX and documentation
- Brief description: UX pass from moderated user testing of the irreversible-action flows (plan review, confirmations, failure recovery), plain-language error coverage, and complete public documentation including API and SDK integration guides.
- How to measure completion: Five recorded user-testing sessions with findings addressed; docs site covers the user flow, the REST API, and the SDK integration guide; all UI errors human-readable (no raw SDK codes), verified by the E2E suite.
- Budget: $13,000
```

### Tranche #3 Completion Date

```
31/01/2027
```

---

## Legal Acknowledgements

Checkboxes, internal use only: Official Rules and Terms, Restrictions on Use of Funds, Sanctions Compliance, Disclaimers and Limitations, General Conditions. All must be checked to submit; read them once, no content to prepare.

---

---

# Appendix — supporting material with no form field (delete before submitting)

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

- [ ] **Pitch video recorded and uploaded** (<3 min, 16:9, YouTube/Vimeo) — does not exist yet
- [ ] **Thumbnail** 16:9 prepared from `docs/logo/` assets
- [ ] Pollar LOI redacted and attached in Traction Evidence
- [ ] Ambassador Affiliation: chapter/city named
- [ ] Both team members have SCF accounts and are added as Team Members
- [ ] All links verified working while logged out, especially docs.lumenwipe.com/architecture
- [ ] Discord invite unified (form vs community doc)
- [ ] "Both prior awards fully delivered" confirmed accurate
- [ ] Budget total confirmed ($120K as drafted, or $96K floor)
- [ ] Tranche dates shifted to the actual award date (DD/MM/YYYY format)
- [ ] Legal acknowledgements read and checked by whoever submits
