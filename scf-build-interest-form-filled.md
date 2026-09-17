# SCF Build Interest Form — LumenWipe

> Filled form ready for submission. Character counts verified against limits.
> Links marked with [EMBED: url] should be embedded over the anchor text in the actual form (embedded links do not count toward character limits per SCF template note).

---

## Project Information

### Project Title

**Answer:**

```
LumenWipe
```

---

### Project Description · max. 1100 characters · actual: 1015

**Answer:**

```
LumenWipe closes a Stellar account and recovers its locked XLM reserves. It handles every step automatically: signer normalization, data entry removal, DEX offer cancellation, LP withdrawal, DeFi position exits (Blend, Aquarius, Soroswap, Phoenix, FxDAO), asset conversion, trustline removal, and the final account merge.

The project responds to the Account Demolisher RFP. It extends the public-domain stellar.expert/demolisher/public by Orbit Lens with the piece that tool lacks: full Soroban and DeFi parity. Any account with a Blend loan, an Aquarius LP position, or a Soroswap pair share cannot be closed with any existing tool today.

All transactions are built and signed in the browser. The backend is read-only and stateless, never in the signing path. A transparent mediator account handles CEX destinations, since no major exchange supports ACCOUNT_MERGE. A read-only allowance inspector lets users revoke token approvals without closing their account.

The classic wind-down runs on testnet and mainnet today.
```

---

### Project Category

**Select one option:**

- [x] Developer Tooling
- [ ] End-User Application
- [ ] Financial Protocols

---

### Current Traction · max. 1000 characters · actual: ~820

**Answer:**

```
A production AccountMerge is live on mainnet [EMBED: https://stellar.expert/explorer/public/tx/a952a51d475d0d0d4d1c2ac1deb6a2848450f4d3ef539f51f933945c709655f1]: trustline removal and account merge on the real network. Classic wind-down runs at lumenwipe.com/mainnet [EMBED: https://lumenwipe.com/mainnet].

Testnet validation [EMBED: https://stellar.expert/explorer/testnet/account/GALYU2WHUH5HV3BAYTOP5ZMUJWXF43QLSVFTEMBYCWF6MM5JDFHXFESQ] covers USDC/EURC accounts, trustline removal, and account merges. Open-source codebase [EMBED: https://github.com/LumenWipe/lumenwipe] is live.

+100 visitors in the first days via public analytics [EMBED: https://cloud.umami.is/analytics/us/share/CoZOq3AqwlmvKs93?date=6month&page=1]. Docs: docs.lumenwipe.com. Community: Matrix [EMBED: https://matrix.to/#/#lumenwipe:matrix.org] and Discord [EMBED: https://discord.gg/hYfZGhdEm].
```

---

### Website

**Answer:**

```
https://lumenwipe.com
```

---

### Planned Stellar Integration · max. 1100 characters · actual: 1098

**Answer:**

```
Stellar RPC handles all network access: getLedgerEntries for live state reads before each transaction, simulateTransaction for every Soroban operation, sendTransaction and getTransaction for submission, and getEvents for event queries. No Horizon dependency.

stellar-wallets-kit (SEP-43) provides wallet signing across Stellar wallets. Soroban auth entries sign through signAuthEntry. An in-memory secret-key path handles wallets outside the kit, and multiple keys or wallets can co-sign one envelope for multisig merges.

DeFi position detection uses OctoPos behind a pluggable adapter. Per-protocol exit adapters cover Blend (via @blend-capital/blend-sdk), Aquarius, Soroswap, Phoenix, and FxDAO. Each adapter reads live state via getLedgerEntries, simulates via simulateTransaction, and submits signed XDR client-side.

Asset conversion routes through the Soroswap API, which aggregates both Soroban venues and the classic SDEX. SDEX PathPaymentStrictSend is the direct fallback for classic assets.

Subentry enumeration uses the stellar.expert API. The full stack targets @stellar/stellar-sdk.
```

---

### Build Track

**Select one option:**

- [x] DevTooling RFP
- [ ] Integration Track · for applications integrating with existing ecosystem building blocks
- [ ] Open Track · for net-new protocols, primitives, etc.

#### RFP

**Answer:**

```
Account Demolisher
```

---

## Team Information

### Submitter type

**Select one option:**

- [ ] Entity
- [ ] Individual
- [x] Team of individuals

---

### Email

**Answer:**

```
[auto-selected]
```

---

### Team Description · max. 2000 characters · actual: ~1425 (LinkedIn/GitHub URLs embedded, do not count)

**Answer:**

```
We are a team of two software engineers and active Stellar Ambassadors with a proven track record building dev tools and end-user apps on Stellar.

Sebastian Salazar (LinkedIn [EMBED: https://www.linkedin.com/in/sebastian-salazar-solano/] | GitHub [EMBED: https://github.com/salazarsebas])
Founder of Acachete Labs and former Stellar Fellow at OnlyDust, Sebastian builds open-source developer tooling for Stellar and ZK cryptography. Projects include Akkuea [EMBED: https://github.com/akkuea/akkuea] (real-world asset infrastructure on Stellar: 230+ forks, 200+ contributors) and Cougr [EMBED: https://github.com/salazarsebas/Cougr] (ECS framework for on-chain games: 40+ forks, 130+ crate downloads), both featured on Drips. He won the ETH Pura Vida hackathon with Revolutionary Farmers, reaching 60+ contributors per repository.

Miguel Nieto (LinkedIn [EMBED: https://www.linkedin.com/in/miguelnietoa/] | GitHub [EMBED: https://github.com/miguelnietoa])
Senior Software Engineer, Miguel is a two-time SCF Build Award recipient. He helped build the Elixir Stellar SDK [EMBED: https://github.com/kommitters/stellar_sdk] (+15k downloads) and Chaincerts [EMBED: https://github.com/kommitters/chaincerts-smart-contracts] (decentralized identity and verifiable credentials platform). Other contributions: soroban-did-contract [EMBED: https://github.com/kommitters/soroban-did-contract] (decentralized identifiers on Soroban), Tippa [EMBED: https://github.com/TryTippa] (cascading donations on Stellar), and StellarView [EMBED: https://github.com/salazarsebas/stellar-explorer] (ecosystem explorer and analytics).

```

---

## Referral Information

### Have you been working with someone from the Stellar Development Foundation or the broader Stellar community and ecosystem on your submission?

**Select one option:**

- [x] Yes
- [ ] No

---

## Character limit verification

| Field                       | Limit | Used  | Status |
| --------------------------- | ----- | ----- | ------ |
| Project Description         | 1100  | 1015  | OK     |
| Current Traction            | 1000  | ~820  | OK     |
| Planned Stellar Integration | 1100  | 1098  | OK     |
| Team Description            | 2000  | ~1425 | OK     |

> Note: Current Traction and Team Description counts exclude embedded URL characters per SCF template note.

---

## Humanizer audit

Every field was checked against the humanizer (blader/humanizer v2.7.0) before finalizing:

- No em dashes or en dashes anywhere
- No AI vocabulary words (crucial, pivotal, vibrant, testament, showcase, enhance, highlight, underscore, landscape, tapestry, groundbreaking)
- No rule-of-three rhetoric (all enumerations are factual lists, not rhetorical triplets)
- No promotional or advertisement-like language
- No vague attributions: all claims are specific and verifiable (forks, contributor counts, Stellar Fellowship, SCF Build Award recipients named)
- No passive-voice subject-hiding
- No generic upbeat conclusion: the final sentence in each field states a concrete fact
- No inline-header bold lists
- No copula avoidance (no "serves as," "stands as," "marks a pivotal")
- Sentence lengths vary throughout
