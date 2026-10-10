---
title: "On-chain monitoring plan"
sidebarTitle: "Monitoring plan"
description: "What LumenWipe watches on the Stellar ledger, which threat each monitor traces back to, and what happens when one fires."
icon: "eye"
---

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
| Mediator account (testnet)         | `GC2VH6XP7HTOZHIX4OC3PU5HUXWY5XANGML4F6GBCNH5MBDFN5MU4WG7`  | Co-signs the forwarding payment of the exchange-mediator flow. Holds friendbot XLM; the no-surplus funding policy (base reserve only, nothing spendable) is for the mainnet account.                                                       |
| Mediator account (mainnet)         | not yet deployed                                            | Exchange closes are testnet-only today. This row exists so the inventory shows the gap rather than hiding it.                                                                                                                              |
| Fee-bump sponsor (testnet)         | `GCMCGC6EJZKJJUTFY6RK43PGOODW6EL6FSHSLXBV4EYSZ3GHNJO3FXAP`  | Pays the network fee for accounts sitting at their minimum balance, via CAP-15. Verifiable as `fee_account` on [`3f4bad4b…`](https://stellar.expert/explorer/testnet/tx/3f4bad4b3fd8b112790a1fb298dab1187d0a6b17a478d67aafd3810b7d8a382e). |
| Fee-bump sponsor (mainnet)         | not yet deployed                                            | Sponsored fees are testnet-only today.                                                                                                                                                                                                     |
| Protocol contracts read and exited | The entries in `apps/api/src/config/contract-registry.json` | Third-party contracts (Blend, Aquarius, Soroswap, Phoenix, FxDAO, and the xBull swap router), not ours. We do not control them; we verify their code hash before building anything against them.                                           |

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
  Soroban conversion - either leave no trace on the ledger or are indistinguishable on-chain from a legitimate
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
read, and `mainnet-registry.integration.test.ts` runs that comparison. `S4a.Elevation.1.M.1` monitors a
risk whose primary control is operational - the mediator holds no spendable surplus - so the alert exists to
catch the funding policy being broken, not to be the only thing standing in the way.

### Registry coverage by protocol (as of 2026-10-10)

The registry comparison behind `S7.Tampering.1.M.1` reads every mainnet entry with `verifiedLive: true`
(`mainnet-registry.integration.test.ts`). What each protocol's rows contribute today, from
`contract-registry.json` (`lastVerified` 2026-10-10):

| Protocol | Mainnet entries compared daily                         | Status                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blend    | factory, backstop and pool, versions v1 and v2         | Active. The same test also checks that the code the Blend factories deploy today matches the registry's representative pools.                                                                                                 |
| Aquarius | router and the three pool types                        | Active. The same test also checks the router's current pool hashes against the registry.                                                                                                                                      |
| Soroswap | factory, pair, router and aggregator                   | Active for the registry hash comparison. No deployer check.                                                                                                                                                                   |
| Phoenix  | pool and stake contracts, versions v1 and v2           | Active for the registry hash comparison. No deployer check. Phoenix's exit also calls a stake contract, so a stake upgrade is covered by this row.                                                                            |
| xBull    | the swap router (conversion quotes, not an exit)       | Active for the registry hash comparison. The router is the contract the browser's `verify()` allows a conversion through, so drift here is a conversion-path signal.                                                          |
| FxDAO    | none: the mainnet vault entry is `verifiedLive: false` | Not monitored. The entry has no `wasmHash` and its deployed code exposes only `evict` and `upgrade`, so there is nothing to compare; no mainnet FxDAO exit is built. The testnet entry is not part of the mainnet comparison. |

Nothing in this table is a new monitor: it records what the existing daily comparison covers, and where it
does not. Monitor implementation is tracked separately (#278).

### How the live ones run

`.github/workflows/onchain-monitors.yml` runs the service-account checks every hour and the registry
comparison once a day at 06:00 UTC, and everything on demand from the Actions tab. All of them are read-only
against public endpoints: no account, no transaction, no funds. The service accounts to watch are one list at
the top of the workflow, keyed by network.

`S7.Tampering.1.M.1` reads each `verifiedLive` mainnet entry's executable hash over RPC and compares it to the
registry. It also runs on every pull request as part of the integration suite, but the schedule is what makes
it a monitor: a contract can be upgraded during a week when nobody opens a pull request.

`S4a.Information.1.M.1` and `S4b.Information.1.M.1` query Horizon for the last 200 transactions touching each
service account and count the ones it sourced. Measured on the testnet sponsor on 2026-09-18: 8 transactions
touching the account, 0 sourced from it. The mediator: 0 as well. The threshold is that measurement, not a
guess.

`S4a.Elevation.1.M.1` has two signals, both in `apps/api/scripts/monitors/service-accounts.ts`. The balance
floor reads each account's native balance from Horizon and compares it to the floor in the list: the mediator's
base reserve, and a provisional top-up level for the sponsor that stands in for `S4b.Denial.1.M.1`'s balance
half until real usage sets one. The forward check reads the effects of every transaction touching the
mediator and fires when it debited more than the merge credited in the same transaction, which is the only way
the mediator can pay out of its own balance. Measured on the testnet mediator on 2026-10-07: 6 transactions,
forward equal to the merge in every one.

A finding opens a GitHub issue, assigned rather than merely labelled, and posts to a private Discord channel
the maintainers watch. A suspected key compromise (the two service-key checks and the forward check) pings
`@everyone`; a registry or balance finding, and a recovery, do not, so the ping keeps its meaning. The two service-key checks and the forward check post again on
every hourly run they keep failing, because a suspected key compromise is worth repeating; a registry or
balance finding posts once, then gets a daily comment on the issue, so the channel stays readable. The next
clean daily run closes the issue and posts the recovery. A finding the webhook cannot deliver fails the run
itself, so a missing or revoked webhook shows up as red rather than as silence.

## 5. What happens when an alert fires?

| Monitor ID              | Severity | Response                                                                                                                                    | Owner       | Status                                | Last reviewed |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------- | ------------- |
| `S4a.Elevation.1.M.1`   | High     | Notify the maintainers; verify the mediator's funding policy; investigate the forward that preceded the drop.                               | Maintainers | Active (hourly)                       | 2026-10-07    |
| `S4a.Spoofing.1.M.1`    | Critical | Notify the maintainers; rotate the mediator key; the mediator rotates without a client change, by design.                                   | Maintainers | Planned                               | 2026-09-17    |
| `S4a.Information.1.M.1` | Critical | Rotate the mediator key immediately; audit every transaction it signed.                                                                     | Maintainers | Active (hourly)                       | 2026-10-07    |
| `S4b.Elevation.1.M.1`   | High     | Notify the maintainers; disable the sponsored-fee endpoint; audit the inner transactions sponsored.                                         | Maintainers | Planned                               | 2026-09-17    |
| `S4b.Denial.1.M.1`      | Medium   | Top up the sponsor; review the per-key rate limit against the observed rate.                                                                | Maintainers | Balance active (hourly); rate planned | 2026-10-07    |
| `S4b.Information.1.M.1` | Critical | Rotate the sponsor key immediately; audit every transaction it paid for.                                                                    | Maintainers | Active (hourly)                       | 2026-10-07    |
| `S7.Tampering.1.M.1`    | High     | Re-verify the contract against the protocol's own release, update the registry entry, and re-run the integration suite before exits resume. | Maintainers | Active (daily)                        | 2026-09-18    |

**Status is honest, not aspirational.** Five monitors are Active: the registry hash comparison daily, and
the two service-key checks, the mediator's balance-and-forward check and the sponsor's balance floor hourly.
Two are Planned, and each is waiting on something specific rather than on effort. `S4a.Spoofing.1.M.1` and
`S4b.Elevation.1.M.1` have to decode a transaction's operations to judge its shape, which is more than a
scheduled query does. `S4b.Denial.1.M.1`'s rate half needs a baseline that does not exist until there is
real usage to measure.

The live service-account checks watch testnet accounts, because those are the only service accounts that
exist. Adding the mainnet mediator and sponsor is one entry each in the workflow's list once they are
deployed.

## 6. Did we do a good job?

- **Does every threat have a monitor, or a recorded reason it cannot be watched on-chain?** Yes. The two
  signing-key surfaces and the exit-adapter surface have monitors; surfaces 1, 2, 3, 5 and 6 are recorded in
  §3 as having no distinguishable on-chain effect, with the controls that do cover them named.
- **Is every threshold grounded in a baseline?** Five of seven are grounded in a baseline of zero, which is
  exact: these are events that never occur in normal operation. `S4b.Denial.1.M.1`'s rate threshold is
  explicitly deferred until there is 30 days of real usage to set it from, rather than guessed now.
- **Does every monitor have a response, an owner and a status?** Yes, in §5.
- **Have any monitors fired?** Yes, once, and as designed. The registry comparison reported Aquarius's
  upstream upgrade on 2026-10-03 and kept reporting until the entries were re-verified against mainnet and
  updated; exits against those pools halted at the registry gate in the meantime. The service-key checks
  report zero sourced transactions for both accounts, and the forward check zero over-payments. Each check
  was also run against a condition that must fail (an account that does source transactions, a floor above
  the balance), to confirm it fails when it should rather than passing because it never looks.
- **Are the addresses current?** Verified 2026-09-18: both testnet accounts resolve on Horizon, and the
  sponsor is confirmed as `fee_account` on the linked transaction. The mainnet rows are empty because those
  accounts do not exist yet.
- **Any threats that only surface off-chain?** Yes, and they are the majority - see §3. That is a
  consequence of the non-custodial design rather than a gap in this plan: there is no pooled balance to
  watch, because there is no pool.

## 7. Maintenance

Revisit whenever the contracts, the addresses or the threat model change, and at every release milestone. The
concrete triggers: a new entry or a bumped `validUntil` in `contract-registry.json`, a mediator or sponsor
key rotation, a new signing key of any kind, and the deployment of the mainnet mediator and sponsor accounts,
which is when the live checks gain their mainnet addresses and the remaining Planned rows become meaningful.
