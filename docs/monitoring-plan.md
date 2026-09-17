---
title: On-chain monitoring plan
description: What LumenWipe watches on the Stellar ledger, which threat each monitor traces back to, and what happens when one fires.
---

Built from the SCF [On-Chain Monitoring Plan Template (Builders)](https://developers.stellar.org/docs/build/security-docs/monitoring/monitoring-template-builders),
using the output of the [threat model](/threat-model). Every monitor here traces back to a threat in that
document; every threat there is accounted for below, either by a monitor or by a recorded reason it cannot be
watched on-chain.

## 1. What are we monitoring?

LumenWipe closes Stellar accounts non-custodially. It deploys **no contracts of its own**, holds **no user
funds**, and has **no admin key over anyone's assets**. The private key that authorizes a close never leaves
the user's browser. That shapes this plan: most of what the threat model covers is client-side or
API-side and leaves no on-chain trace, so the on-chain surface is small and specific, and the rest is listed
in §3 as off-chain monitoring rather than padded into on-chain rules that could never fire.

What LumenWipe does have on the ledger is **two service accounts that hold a signing key**, and the
**third-party protocol contracts it reads and builds exits against**.

| Component                          | On-chain address                                            | Notes                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mediator account (testnet)         | `GC2VH6XP7HTOZHIX4OC3PU5HUXWY5XANGML4F6GBCNH5MBDFN5MU4WG7`  | Co-signs the forwarding payment of the exchange-mediator flow. Funded to its base reserve only, deliberately: it must hold no spendable surplus.                                                                                           |
| Mediator account (mainnet)         | not yet deployed                                            | Exchange closes are testnet-only today. This row exists so the inventory shows the gap rather than hiding it.                                                                                                                              |
| Fee-bump sponsor (testnet)         | `GCMCGC6EJZKJJUTFY6RK43PGOODW6EL6FSHSLXBV4EYSZ3GHNJO3FXAP`  | Pays the network fee for accounts sitting at their minimum balance, via CAP-15. Verifiable as `fee_account` on [`3f4bad4b…`](https://stellar.expert/explorer/testnet/tx/3f4bad4b3fd8b112790a1fb298dab1187d0a6b17a478d67aafd3810b7d8a382e). |
| Fee-bump sponsor (mainnet)         | not yet deployed                                            | Sponsored fees are testnet-only today.                                                                                                                                                                                                     |
| Protocol contracts read and exited | The entries in `apps/api/src/config/contract-registry.json` | Third-party contracts (Blend, Aquarius, Soroswap), not ours. We do not control them; we verify their code hash before building anything against them.                                                                                      |

The registry carries a `validUntil` date and every entry's `wasmHash`. **Keeping that file current is the
single most important piece of inventory hygiene here** - a stale entry is how a monitor, or an exit, quietly
starts working against the wrong code.

## 2. What could go wrong?

Carried over from the [threat model](/threat-model), which runs one STRIDE pass per surface. That document
identifies threats by surface and category rather than by number, so each threat below is given a stable id of
the form `S<surface>.<Category>.<n>`.

| Threat ID           | Threat (from the threat model)                                                                                                                         | Affected component | Severity |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | -------- |
| `S4a.Elevation.1`   | The mediator is tricked into forwarding more than the merge actually delivered, paying the difference from its own balance (the documented TOCTOU gap) | Mediator account   | High     |
| `S4a.Spoofing.1`    | A caller submits a transaction shaped to make the mediator sign something other than its own forward payment                                           | Mediator account   | Critical |
| `S4a.Information.1` | The mediator's secret key leaks and is used to sign transactions LumenWipe never built                                                                 | Mediator account   | Critical |
| `S4b.Elevation.1`   | The fee sponsor is induced to pay fees for transactions that are not LumenWipe closes                                                                  | Fee-bump sponsor   | High     |
| `S4b.Denial.1`      | The fee sponsor is drained by repeated sponsored requests until it can no longer pay for legitimate closes                                             | Fee-bump sponsor   | Medium   |
| `S4b.Information.1` | The sponsor's secret key leaks and is used to sign or fee-bump arbitrary transactions                                                                  | Fee-bump sponsor   | Critical |
| `S7.Tampering.1`    | A protocol contract LumenWipe exits through is upgraded to code the registry has not verified                                                          | Protocol contracts | High     |

## 3. What does exploitation look like on-chain?

| Threat ID           | Exploitation scenario                                                                                                                                                                    | Observable on-chain effect(s)                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S4a.Elevation.1`   | An adversary who controls the account being merged drains it after co-signing, then submits: the merge delivers dust while the forward still pays the co-signed amount from the mediator | The mediator's native balance falls below its base reserve; a payment sourced from the mediator materially exceeds the `accountMerge` in the same transaction |
| `S4a.Spoofing.1`    | A malformed or hostile envelope is co-signed and submitted                                                                                                                               | A transaction carrying the mediator's signature whose operations are not exactly `accountMerge` into the mediator plus `payment` from it                      |
| `S4a.Information.1` | The leaked key signs transactions LumenWipe never produced                                                                                                                               | Any transaction signed by the mediator that LumenWipe's own records do not account for; any operation type other than the two above                           |
| `S4b.Elevation.1`   | The sponsor fee-bumps an envelope that is not a close                                                                                                                                    | A fee-bump where `fee_account` is the sponsor and the inner transaction's operations are not a LumenWipe close shape                                          |
| `S4b.Denial.1`      | Repeated sponsored requests exhaust the balance                                                                                                                                          | The sponsor's native balance trending toward its base reserve; a rising rate of `fee_account` appearances per hour                                            |
| `S4b.Information.1` | The leaked key pays fees for, or sources, arbitrary transactions                                                                                                                         | Any transaction where the sponsor is `source_account` rather than only `fee_account`                                                                          |
| `S7.Tampering.1`    | A pool is upgraded; LumenWipe builds an exit against an interface nobody verified                                                                                                        | The live executable hash of a registered contract no longer matches its `wasmHash` in the registry                                                            |

**Threats with no on-chain effect, monitored off-chain instead.** The threat model's surfaces 1, 2, 3, 5 and 6

- client-side key handling, the session state machine, API transaction construction, allowance revocation and
  Soroban conversion - either never touch the ledger or are indistinguishable on-chain from a legitimate
  user-authorized action, because that is exactly what they are: the user signs in their own browser with their
  own key. A compromised frontend serving hostile bytes is the clearest example; the control against it is
  `verifyCloseTransaction`, the client-side trust anchor, not a ledger watcher. These are covered by
  application logging, the adversarial test suite and the integration suite in CI, and are recorded here so the
  gap is deliberate rather than overlooked.

## 4. What will we monitor for?

| Monitor ID              | Observable on-chain effect                         | Trigger condition & baseline                                                                                                                                                   | Monitoring rule                                                                         |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `S4a.Elevation.1.M.1`   | Mediator balance below base reserve                | Native balance < 1.0 XLM. Baseline: funded to base reserve only and never expected to fall below it.                                                                           | Alert on any drop below the reserve floor.                                              |
| `S4a.Spoofing.1.M.1`    | Mediator-signed transaction of an unexpected shape | Any transaction involving the mediator whose operations are not exactly `accountMerge` + `payment` from the mediator. Baseline: zero; every legitimate co-sign has that shape. | Alert on any other shape.                                                               |
| `S4a.Information.1.M.1` | Mediator as transaction source                     | Any transaction where the mediator is `source_account`. Baseline: zero; the API never sources from it.                                                                         | Alert immediately; treat as a suspected key compromise.                                 |
| `S4b.Elevation.1.M.1`   | Sponsor fee-bumping a non-close                    | Any fee-bump with the sponsor as `fee_account` whose inner transaction is not a close. Baseline: zero.                                                                         | Alert on the first occurrence.                                                          |
| `S4b.Denial.1.M.1`      | Sponsor balance trend                              | Native balance below a top-up floor, or sponsored transactions per hour above the observed norm. Baseline: to be set from the first 30 days of real usage rather than guessed. | Warn on the balance floor; warn on an unusual rate.                                     |
| `S4b.Information.1.M.1` | Sponsor as transaction source                      | Any transaction where the sponsor is `source_account` rather than only `fee_account`. Baseline: zero.                                                                          | Alert immediately; treat as a suspected key compromise.                                 |
| `S7.Tampering.1.M.1`    | Registry hash drift                                | A registered contract's live executable hash differs from its `wasmHash`. Baseline: every entry matches, as of `lastVerified`.                                                 | Alert on any mismatch; exits against that contract already fail closed in the meantime. |

Two of these are already enforced in code rather than only watched. `S7.Tampering.1.M.1` is the monitoring
counterpart of a control that exists: an unknown code version blocks the exit before any contract state is
read, and `mainnet-registry.integration.test.ts` runs that comparison in CI. `S4a.Elevation.1.M.1` monitors a
risk whose primary control is operational - the mediator holds no spendable surplus - so the alert exists to
catch the funding policy being broken, not to be the only thing standing in the way.

## 5. What happens when an alert fires?

| Monitor ID              | Severity | Response                                                                                                                                    | Owner       | Status         | Last reviewed |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------- | ------------- |
| `S4a.Elevation.1.M.1`   | High     | Notify the maintainers; verify the mediator's funding policy; investigate the forward that preceded the drop.                               | Maintainers | Planned        | 2026-09-17    |
| `S4a.Spoofing.1.M.1`    | Critical | Notify the maintainers; rotate the mediator key; the mediator rotates without a client change, by design.                                   | Maintainers | Planned        | 2026-09-17    |
| `S4a.Information.1.M.1` | Critical | Rotate the mediator key immediately; audit every transaction it signed.                                                                     | Maintainers | Planned        | 2026-09-17    |
| `S4b.Elevation.1.M.1`   | High     | Notify the maintainers; disable the sponsored-fee endpoint; audit the inner transactions sponsored.                                         | Maintainers | Planned        | 2026-09-17    |
| `S4b.Denial.1.M.1`      | Medium   | Top up the sponsor; review the per-key rate limit against the observed rate.                                                                | Maintainers | Planned        | 2026-09-17    |
| `S4b.Information.1.M.1` | Critical | Rotate the sponsor key immediately; audit every transaction it paid for.                                                                    | Maintainers | Planned        | 2026-09-17    |
| `S7.Tampering.1.M.1`    | High     | Re-verify the contract against the protocol's own release, update the registry entry, and re-run the integration suite before exits resume. | Maintainers | Active (in CI) | 2026-09-17    |

**Status is honest, not aspirational.** One monitor is Active: the registry hash comparison, which runs in CI
today. The six ledger watchers are Planned - the accounts they watch exist only on testnet, and standing them
up against testnet accounts that a network reset can wipe would produce a plan that looks implemented and
is not. They are specified now, with their triggers and responses, and go live with the mainnet mediator and
sponsor accounts as part of the mainnet launch tranche.

## 6. Did we do a good job?

- **Does every threat have a monitor, or a recorded reason it cannot be watched on-chain?** Yes. The two
  signing-key surfaces and the exit-adapter surface have monitors; surfaces 1, 2, 3, 5 and 6 are recorded in
  §3 as having no distinguishable on-chain effect, with the controls that do cover them named.
- **Is every threshold grounded in a baseline?** Five of seven are grounded in a baseline of zero, which is
  exact: these are events that never occur in normal operation. `S4b.Denial.1.M.1`'s rate threshold is
  explicitly deferred until there is 30 days of real usage to set it from, rather than guessed now.
- **Does every monitor have a response, an owner and a status?** Yes, in §5.
- **Have any monitors fired?** The registry comparison runs in CI and has not reported drift. The ledger
  watchers are not yet live, so the honest answer is that they have not been exercised.
- **Are the addresses current?** Verified 2026-09-17: both testnet accounts resolve on Horizon, and the
  sponsor is confirmed as `fee_account` on the linked transaction. The mainnet rows are empty because those
  accounts do not exist yet.
- **Any threats that only surface off-chain?** Yes, and they are the majority - see §3. That is a
  consequence of the non-custodial design rather than a gap in this plan: there is no pooled balance to
  watch, because there is no pool.

## 7. Maintenance

Revisit whenever the contracts, the addresses or the threat model change, and on every tranche boundary. The
concrete triggers: a new entry or a bumped `validUntil` in `contract-registry.json`, a mediator or sponsor
key rotation, a new signing key of any kind, and the deployment of the mainnet mediator and sponsor accounts,
which is what moves six of these monitors from Planned to Active.
