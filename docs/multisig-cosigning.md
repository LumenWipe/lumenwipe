---
title: "Multisig cosigning across devices"
sidebarTitle: "Multisig cosigning"
description: "Design for completing a multisig close when cosigners are on other devices: the journeys, the exchanged artifact, the checks each device runs, validity, failure handling, and the interim statement."
icon: "users"
---

> **Status: design reviewed, partly implemented.** It changes what the signing screen accepts as input and
> what the app agrees to sign, so it went through a security design review before anything is built. The
> outcome and the changes it required are in [Section 14](#14-security-design-review). The API change in
> Section 3.1, signer normalization as the first transaction of a multisig close, is built (INV-51). The
> two engine changes of check 7.3g are built in the SDK's `runClose` (INV-52); the hub does not use them yet.
> Nothing described here as "the station" or "the artifact" exists in the code today.

## 1. Summary

Today only signers present in one browser session can sign a multisig close. When a transaction stops
short of its signing weight, the close engine raises `InsufficientSignatureWeightError` and
`apps/web/hooks/useCloseExecution.ts` keeps the partly signed envelope in `pendingRoundRef`, in memory. The
next signer must connect in the same browser, and a reload loses the envelope.

This design lets a cosigner on another device sign the same transaction, with these properties:

- The initiator's browser (the **hub**) stays the only owner of the close: the plan, the rounds, the
  mediator and fee-bump preparation, submission, reconciliation by hash and the unconfirmed-submission hold.
  The initiator holds the account's master key (Section 3.1).
- A cosigner's browser runs a **cosign station**: a LumenWipe page that verifies one transaction, signs it,
  and hands back signatures only. It never submits and keeps nothing.
- Devices exchange an **artifact**: a small, strict JSON document that carries one transaction envelope.
  Every device treats a received artifact as untrusted input.

Non-goals:

- No transaction is built in the browser. The web only parses, verifies, signs and submits what the API
  built (INV-18 in the [invariant register](/invariants)).
- No server relays, stores or forwards envelopes or signatures.
- Nothing changes for a close signed in one browser.

## 2. Protocol facts this design relies on

| Fact                                                                                                                                                                                                    | Source                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time bounds are UNIX timestamps judged against ledger time. A transaction submitted too early or too late does not enter the transaction set.                                                           | [Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions)                                                                                                                                            |
| The result codes are `txTOO_EARLY` (ledger close time before `minTime`) and `txTOO_LATE` (ledger close time after `maxTime`).                                                                           | [`Stellar-transaction.x`, `TransactionResultCode`](https://github.com/stellar/stellar-xdr/blob/579a90b2654e3811e8b672e128a5e094c7325b27/Stellar-transaction.x#L2021-L2022)                                                                                                |
| A transaction's sequence number must be exactly one greater than the source account's, otherwise `txBAD_SEQ`. Once any transaction from the account lands, every other envelope on that number is dead. | [Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions), [`txBAD_SEQ`](https://github.com/stellar/stellar-xdr/blob/579a90b2654e3811e8b672e128a5e094c7325b27/Stellar-transaction.x#L2024)           |
| The network passphrase is part of the hash each signer signs.                                                                                                                                           | [Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions)                                                                                                                                            |
| The hash covers the transaction, not its signatures, so signatures made on different devices over the same transaction can be combined on one envelope.                                                 | [`TransactionSignaturePayload`](https://github.com/stellar/stellar-xdr/blob/579a90b2654e3811e8b672e128a5e094c7325b27/Stellar-transaction.x#L1012-L1024)                                                                                                                   |
| An envelope carries at most 20 signatures (`DecoratedSignature signatures<20>`).                                                                                                                        | [`Stellar-transaction.x`](https://github.com/stellar/stellar-xdr/blob/579a90b2654e3811e8b672e128a5e094c7325b27/Stellar-transaction.x#L968-L973), [Signatures and multisig](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)       |
| A signature the transaction does not need fails it, even when the signature is valid: `txBAD_AUTH_EXTRA`, "unused signatures attached to transaction".                                                  | [`Stellar-transaction.x`](https://github.com/stellar/stellar-xdr/blob/579a90b2654e3811e8b672e128a5e094c7325b27/Stellar-transaction.x#L2030), [Signatures and multisig](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)           |
| A signature hint is 4 bytes (`typedef opaque SignatureHint[4]`). It only narrows which key to try. It proves nothing until the signature verifies against that key.                                     | [`Stellar-types.x`](https://github.com/stellar/stellar-xdr/blob/579a90b2654e3811e8b672e128a5e094c7325b27/Stellar-types.x#L84)                                                                                                                                             |
| A transaction holds at most 100 operations (`MAX_OPS_PER_TX = 100`). A smart contract transaction holds one.                                                                                            | [`Stellar-transaction.x`](https://github.com/stellar/stellar-xdr/blob/579a90b2654e3811e8b672e128a5e094c7325b27/Stellar-transaction.x#L12), [Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions) |
| A pre-authorized transaction signer is removed when its transaction is applied, whether it succeeds or fails. A hash(x) preimage is public once submitted.                                              | [Signatures and multisig](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)                                                                                                                                                        |
| A SEP-7 `tx` request without `callback` asks the handler to sign and submit. With `callback`, the handler POSTs the signed XDR to that URL.                                                             | [SEP-0007](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)                                                                                                                                                                                 |
| A version 40 QR code at error correction level L holds at most 2,953 bytes in 8-bit binary mode.                                                                                                        | [DENSO WAVE, QR code version list](https://www.qrcode.com/en/about/version.html) (the inventor of the QR code; table for versions 31 to 40)                                                                                                                               |

Facts from this codebase that also shape the design:

- The API builds every close transaction with an upper time bound 300 seconds after the build
  (`TX_TIMEOUT_SECONDS` in `apps/api/src/config/constants.ts`). `verify()` refuses a transaction with no
  upper bound or one valid more than 15 minutes ahead (INV-32). The mediator and fee-bump sponsor sign only
  an envelope that has not expired and expires within 330 seconds (`MAX_SIGNED_VALIDITY_SECONDS`, which is
  `TX_TIMEOUT_SECONDS + 30`, INV-38). One API submission is bounded by `SUBMIT_BUDGET_MS`, 35 seconds.
- The close engine verifies a transaction once, before its first signature, and does not verify a resumed
  transaction again (`packages/sdk/src/close-engine.ts`). That is sound in one session. A second device has
  no memory of that verification, so it must run `verify()` itself.
- A multisig close needs the full signing weight on one transaction only. When no single key of the account
  reaches every threshold (`normalizesSignersFirst` in `apps/api/src/lib/stellar/tx-builder/index.ts`), the
  first round of `buildCloseTransactions` is signer normalization alone: the signer removals and the
  threshold reset, ahead of the exit, token, conversion and claim rounds, and never fused with the merge or
  with asset handling. Every later transaction needs only the master key. Before this change normalization
  shared a transaction with the asset handling, and every round before it needed the full weight.

## 3. Model: one hub, stateless stations

The hub keeps the paused round exactly as today, in `pendingRoundRef`. For a transaction that needs weight
from a key on another device, it exports a **request artifact**. A station verifies the request, signs it,
and exports a **response artifact** that carries only the signatures it added. The hub takes those
signatures, never the envelope body, merges a minimal set of them onto its own envelope, and resumes the
round. Several stations can sign the same request at the same time.

Alternative rejected: a chain, where the envelope passes from device to device and the last one submits.
It would split reconciliation by hash (INV-45, INV-46) and the continuation into the next round across
devices, and it would hand cosigners an envelope that other people's signatures had made ready to submit.

### 3.1 Which transactions are cosigned in v1

Decision: for a multisig close, the API emits signer normalization as **its own first transaction**,
before any exit, token, conversion or claim round, and never fuses it with the merge. That transaction is
the only one a station signs in v1. After it is confirmed, the master key alone signs the rest of the close
on the hub, so the initiator must hold the master key. This API change ships before the station, and is
built (INV-51). It applies when the master key carries weight and no single ed25519 key reaches the highest
of the three thresholds; a close one key can sign keeps its layout. The plan step states the cost below,
and the API emits the transaction only while no later refusal is already known from the state it reads.

Alternative: leave the builder as it is and refuse cross-device cosigning for any multisig close with a
conversion or a round before normalization. Rejected, for these reasons:

- It would exclude most multisig closes: any account with a DeFi position, a token balance, a conversion
  or a claimable balance.
- With today's layout every round before normalization needs its own handoff, each in its own 300-second
  window. With normalization first, a close needs exactly one handoff.
- The normalization transaction holds only `set_options` operations from the account: signer removals and
  one threshold reset. The station can check it completely and mechanically, with no conversion floor, no
  contract call and no quote.
- The step it adds to the trust model already exists. Every batched multisig close today has a
  normalization transaction without a merge, which must carry the master key and reset the thresholds
  (INV-43, `assertMasterSignsSignerRemoval` in `apps/web/lib/stellar/signing-guards.ts`). Moving it first
  changes the order, not what cosigners agree to.

The cost is stated plainly. A cosigner who signs normalization gives the master key holder sole control
of the account, and the master key holder alone then decides the destination and everything else. A fused
multisig close, where cosigners sign the merge itself, is no longer offered. The station says so before it
signs (Section 5).

Until the station ships, a multisig close cannot be cosigned across devices at all, and the interim
statement (Section 12) applies.

## 4. Initiator journey (hub)

1. The initiator reviews and confirms the plan as today. The review screen says which keys must sign and
   that the master key then completes the close alone.
2. The normalization transaction pauses for more weight. The paused panel, alongside today's "connect
   another signer", offers **Sign on another device**. It shows:
   - the signers still able to add weight, from the live round, as `ExecutionWizard` already lists them;
   - the transaction hash fingerprint from the pre-sign panel
     (`apps/web/components/execution/PreSignPanel.tsx`), to be read to the cosigner;
   - the time left before the transaction expires, counted down from its `maxTime`.
3. The initiator saves the request as a file or copies it as text and sends it through any channel. The
   export never contains the fingerprint: it travels separately, by voice or another channel.
4. The screen gives the cosigner's instructions with the exact origin the hub is served from, written out
   in full: "Open `<origin>/cosign` yourself, in a browser, by typing it. Do not open a link you were sent.
   Type this account address, then import the request. Before you sign, type the 16 characters of the
   transaction hash I read to you. This request expires at `<time>`."
5. The initiator imports each response as a file or as pasted text. The panel updates the collected weight.
   When the weight is met, the hub re-reads the account's signers and thresholds and continues: preparation,
   submission, reconciliation.
6. When a request expires before the weight is met, the panel offers **Rebuild and re-export**: a new build
   of the same step, a new request, and a new fingerprint.

## 5. Cosigner journey (station)

The cosigner opens LumenWipe and goes to the cosign page by typing the address. No link format exists (see
[decision 1](#11-decisions)).

1. Choose the network and type or pick the account. The station reads the account live right away, before
   anything is imported, because that read is the slowest step.
2. Import the request, as a file or pasted text.
3. Read the plain-language summary decoded from the transaction: which signers are removed, the new
   thresholds, the fee. For a transaction that removes signers or resets thresholds with no merge, the
   station says before signing: "Signing this gives the master key, `<master key>`, sole control of this
   account. After it, the master key holder alone decides where the funds go."
4. Type the 16 characters of the hash fingerprint the initiator reads out. The station compares them with
   the hash it computed itself.
5. Connect one signer, held as the one active signer (`useActiveSigner`). Wallets come first. A secret key
   sits behind a warning that the station is a page on a shared origin and that a wallet keeps the key out of
   the page.
6. Sign, then save or copy the response and send it back. The page then forgets the transaction and the
   signer.

When a later reviewed change lets a station sign a transaction that merges or pays out, the station also
asks the cosigner to type the destination and memo, and checks transfers mechanically (Section 7.2).

## 6. The artifact

```json
{
  "format": "lumenwipe-cosign",
  "version": 1,
  "direction": "request",
  "network": "public",
  "account": "G...",
  "envelope": "<base64 TransactionEnvelope XDR>"
}
```

- `direction` is `request` or `response`. `network` is `public` or `testnet`. `account` must equal the
  account the cosigner typed or picked before importing. No other field is accepted, and an unknown field,
  version or value refuses the artifact.
- It carries no hash, no fingerprint, no plan, no expectations, no signer list and no URL. The receiver
  computes or reads each of those itself, so nothing in the artifact can stand in for a check or point a
  cosigner anywhere.
- A request carries the envelope with **no signatures**. A response carries the same transaction with
  **only the signatures that station added**.
- The transport is a downloaded `.json` file or the same text copied and pasted. Both go through one
  parser, which refuses an artifact above a fixed size cap before parsing it. The implementation sets the
  cap above the network's current per-transaction size limit, which is a live network setting.

## 7. Checks on each device

### 7.1 Station, on importing a request

| #   | Check                                                                                                                                                                                                                                                                                                                                                                                     | Refusal                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| a   | Under the size cap, valid JSON, exactly the fields above, `version` 1, `direction` `request`.                                                                                                                                                                                                                                                                                             | "This is not a LumenWipe cosign request."                                           |
| b   | `network` equals the network chosen on the station. Decoding the envelope checks nothing about the network: the passphrase binds only through the hash. The station computes the hash with its own network's passphrase, so every check below and the signature it makes hold only on that network. A fee-bump envelope is refused: the hub adds a fee bump only after the weight is met. | "This request is for another network."                                              |
| c   | The envelope carries no signatures.                                                                                                                                                                                                                                                                                                                                                       | "This request already carries signatures. Ask for a new one."                       |
| d   | `account` and the transaction's source both equal the account the cosigner typed. The transaction's sequence number is the account's next one in the station's live read.                                                                                                                                                                                                                 | "This request is for another account." or "This transaction can no longer be used." |
| e   | The time bounds pass `verify()`'s expiry rule, `minTime` is not in the future, and at least 90 seconds remain at import.                                                                                                                                                                                                                                                                  | "This request expires too soon. Ask for a new one."                                 |
| f   | The transaction contains only operations the v1 station accepts (Section 7.2), and `verifyCloseTransaction()` in `apps/web/lib/stellar/verify.ts` passes with `preAuthorized: false`, always.                                                                                                                                                                                             | The message `verify()` gives, or "This step cannot be signed on another device."    |
| g   | The typed fingerprint equals the station's own fingerprint of the hash.                                                                                                                                                                                                                                                                                                                   | "The characters do not match. Do not sign. Check them with the initiator."          |
| h   | The signer is an ed25519 signer of the account in the station's live read, with weight above 0.                                                                                                                                                                                                                                                                                           | "This key is not one of the account's signers."                                     |
| i   | At least 60 seconds remain when the signer is asked: the hub still needs the return trip and up to `SUBMIT_BUDGET_MS` to submit.                                                                                                                                                                                                                                                          | "Too little time is left. Ask for a new request."                                   |
| j   | After signing, the approved-hash check: the signed transaction's hash equals the hash computed before signing. Then the weight check: weight rises, and it rises by the named signer's own signature (#733).                                                                                                                                                                              | "The signed transaction does not match what you approved."                          |

The station's account read sends the API the network and the account address, through the same endpoint
the hub uses (`GET /v1/{network}/account/{address}`). Nothing else leaves the device: the envelope, the
artifact and the cosigner's inputs are never sent anywhere. The station makes no quote or build request.

### 7.2 What the station accepts and verifies against

In v1 the station accepts a transaction only when every operation is a `set_options` sourced from the
account that removes a signer other than the master key (weight 0) or resets the thresholds, and the
transaction resets the thresholds so the master key alone meets them. It refuses a merge, a payment, a
conversion, a trustline change, a claim and any contract call. `verify()` runs with the signers and
thresholds from the station's live read, and with destination, transfer, conversion and exit expectations
that are empty, so it refuses anything else as well.

Not every expectation can come from the station's own inputs, and none may come from the transaction it is
checking. Comparing a transaction with expectations decoded from that same transaction checks nothing. So
when a later reviewed change admits a merge or payments, the station checks them mechanically, never by a
confirmation alone:

| Item                        | Mechanical rule                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge                       | Goes to the destination the cosigner typed, with the memo the cosigner typed. The bundled exchange registry applies as on the hub.                                          |
| Classic or token transfer   | Goes to the typed destination, to the asset's own issuer derived from the asset itself, or to an address the cosigner typed for that asset. Any other recipient is refused. |
| Transfer amount             | At least the floor taken from the station's live read of the account's balance of that asset, never from the decoded transaction.                                           |
| Trustline added for a claim | Paired with a claim of the same asset in the same transaction. An added trustline with no such claim is refused.                                                            |
| Conversion or DeFi exit     | Refused. A conversion floor needs a quote, and a quote request would send the API what the artifact says is being sold.                                                     |

### 7.3 Hub, on importing a response

| #   | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a   | Same parsing rules, with `direction` `response`, and the same network and account as the paused round. A paused round exists for this close.                                                                                                                                                                                                                                                                                                                                                                                   |
| b   | The decoded transaction's hash equals the approved hash stored in the paused round when the hub verified it (see g). It is never recomputed from the round's XDR.                                                                                                                                                                                                                                                                                                                                                              |
| c   | Each signature maps to exactly one ed25519 signer of the round with weight above 0, by hint, and verifies against that key over the approved hash. The candidates exclude `hash_x`, `preauth_tx` and `ed25519_signed_payload` signers. One signature that maps to no signer, or to more than one, or does not verify, refuses the whole response. `evaluateSignatureContributions` is not enough alone, because it skips a signature that matches no signer.                                                                   |
| d   | The response holds at most one signature per key, and no key that already contributed to the hub's envelope. Otherwise it is refused.                                                                                                                                                                                                                                                                                                                                                                                          |
| e   | Only those signatures are used, never the response's body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| f   | The hub attaches a **minimal set**: from its own signatures and the new ones, a set that meets the required weight and from which no signature can be removed while still meeting it. Signatures outside the set are pruned. The set keeps 20 signatures or fewer, and the transaction has not expired. A signature an existing guard requires, such as the master key's on normalization (INV-43), is part of the set, and the rest is minimal around it.                                                                     |
| g   | Two engine changes resume the round. Each is marked for review at implementation. (1) When the accumulated weight already meets the required weight, the engine skips `sign` and goes straight to `prepare`. Today `signOrThrow` always calls `deps.sign`, the hub's `sign` refuses a call that adds no weight, and with no signer `requiredWeight` is infinite, so merged signatures could never reach submission. (2) `PendingRound` stores `approvedHash`, computed from the exact XDR `verify()` approved, at verify time. |
| h   | Before `prepare`, the hub re-reads the account's signers and thresholds live and continues only when the attached set still meets them.                                                                                                                                                                                                                                                                                                                                                                                        |

The minimal set matters because a valid signature that the network does not count fails the whole
transaction with `txBAD_AUTH_EXTRA`, and the order in which the network counts signatures is not something
the hub controls. Example: signers A (weight 1), B (weight 1) and C (weight 2), high threshold 2.

- The hub holds A. A response brings B. A and B together meet 2 and neither can be removed: attach both.
- The hub holds A. A response brings C. C alone meets 2, so A's signature is not needed. Attaching both
  risks `txBAD_AUTH_EXTRA` when C is counted first. The hub attaches C and prunes A.
- The hub holds A. Two responses bring B and C. Both {A, B} and {C} are minimal. The hub picks the set
  with fewer signatures, {C}, and prunes A and B.

## 8. Validity

- One artifact covers one transaction of one round. It is valid until that transaction's `maxTime`, and
  only while its sequence number is the account's next one.
- A rebuild on the same sequence number, after an expiry or a cancel, does not end the old transaction on
  the network. Until its `maxTime`, responses for it can still be combined and submitted, and whichever of
  the two transactions lands first uses the sequence number, so the other fails with `txBAD_SEQ`.
- The sequence number does not guard the signer list. An operation sourced from this account inside
  another account's transaction can change its signers or thresholds without changing its sequence number.
  That is why the hub re-reads the signers and thresholds before `prepare` (check 7.3h).
- A confirmed pre-authorized submission, or any other transaction from the account, uses up the sequence
  number and ends every outstanding artifact.
- Each device judges expiry by its own clock, and the network by ledger time. A wrong clock can only make a
  device refuse early or the network refuse late. It cannot make an expired transaction land.

### 8.1 Validity window: 300 seconds in v1

Decision: keep the API's 300-second window. A longer one would raise how long a response stays a usable
authorization (Section 9), and the mediator and sponsor rule (INV-38, 330 seconds) would have to be met at
preparation time anyway. The design makes 300 seconds workable instead:

- The station reads the account before import, so the slowest step is outside the window.
- The station refuses with less than 90 seconds left at import, or 60 seconds at signing.
- The hub offers **Rebuild and re-export** on expiry.

Worked example: one cosigner on a call, station open with the account read, wallet connected. The window
starts when the API builds the normalization transaction.

| Step                                                              | Seconds | Elapsed | Left |
| ----------------------------------------------------------------- | ------: | ------: | ---: |
| API builds the transaction, the hub verifies it                   |       5 |       5 |  295 |
| Initiator signs with the master key, the round pauses             |      20 |      25 |  275 |
| Initiator exports the request and sends it in a chat              |      20 |      45 |  255 |
| Cosigner imports it (90-second floor passes)                      |      10 |      55 |  245 |
| Cosigner reads the signer removals and the sole-control statement |      30 |      85 |  215 |
| Initiator reads the fingerprint, the cosigner types it            |      20 |     105 |  195 |
| Cosigner signs in their wallet (60-second floor passes)           |      30 |     135 |  165 |
| Cosigner exports the response and sends it                        |      20 |     155 |  145 |
| Initiator imports it, the hub merges and re-reads signers         |      15 |     170 |  130 |
| Preparation and submission, at most `SUBMIT_BUDGET_MS`            |      35 |     205 |   95 |

A prepared cosigner finishes with about 95 seconds to spare. An unprepared one adds steps the table does
not have, such as opening a mobile wallet and pairing it over WalletConnect, which can take a minute or
more. That is what **Rebuild and re-export** is for. With two cosigners, both sign the same request in
parallel, so the time grows by the slower of the two, not by both.

Handoff count: with normalization first (Section 3.1), a multisig close needs one cross-device handoff.
With the builder as it was before that change it would have needed one for every transaction up to and
including the one that normalizes the signers. That is every exit, token, conversion and claim round,
plus the batch that removes the signers.

## 9. Failure, reload and abandonment

| Event                                     | Behavior                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hub reload                                | The paused round is lost, as today ([decision 5](#11-decisions)). A response for it is refused, because its hash matches no round. The close continues with a new build, and every signer signs again.                                                             |
| Station reload or tab closed              | Nothing of value is lost. The station holds no state, and a secret key is wiped as in [Section 13.2 of the architecture](/architecture#132-key-handling).                                                                                                          |
| Request expired or too close to expiry    | Refused on the station. The hub offers **Rebuild and re-export**.                                                                                                                                                                                                  |
| Cosigner declines or the wallet times out | Only the station's attempt ends. The hub's round is untouched. A decline or timeout on the hub itself keeps the round until its `maxTime`; past it, the round is dropped.                                                                                          |
| Initiator cancels                         | The hub discards the round. Requests carry no signatures. Responses already sent stay usable until `maxTime` (see below).                                                                                                                                          |
| Response never comes back                 | The hub's round stays paused until `maxTime`, then offers a rebuild.                                                                                                                                                                                               |
| Submitted outside LumenWipe               | The hub fee-bumps some transactions, which changes the outer hash. A transaction submitted elsewhere is found only by its inner hash. For a cross-device round, the hub looks up the inner hash as well as its own submission's hash before it reports an outcome. |
| Wrong or tampered artifact                | Refused by the checks in Section 7, with nothing signed or merged.                                                                                                                                                                                                 |

Residual risk: a response is a bearer authorization until the transaction's `maxTime`. Anyone who holds
enough of them to meet the threshold can submit the transaction: a cosigner, a party that collected the
responses of several stations signing in parallel, or anyone who intercepted responses in transit. What
bounds this is that every signature in a response is over a transaction that the signing device verified
itself, that the window is at most 300 seconds, and that the transaction stops being valid once any other
transaction from the account uses its sequence number. The hub learns the outcome from its lookup by hash
and from its next live read (INV-02, INV-41).

## 10. hash(x) and pre-authorized signers

- **hash(x).** The station accepts wallet and secret-key signers only. A preimage is entered only on the
  hub, where the check that it is attached only to the transaction removing its own signer stays (INV-42).
  A preimage never travels in an artifact: it is a bearer secret that anyone who reads it can use until its
  signer is removed. A response carrying a hash(x) signature is refused by check 7.3c.
- **Pre-authorized transactions.** These stay a hub path (`apps/web/components/execution/PreAuthTxInput.tsx`
  and `submitPreAuthTransaction`, with its two-step review). They need no signature, so they need no
  artifact. The station always verifies with `preAuthorized: false`. When a pre-authorized transaction is
  confirmed and uses up the round's sequence number, every outstanding artifact for that round ends.
- **Signed-payload signers** (`ed25519_signed_payload`) cannot sign in this flow on either device.

## 11. Decisions

1. **Transport: file and pasted text. No link, no QR code in v1.** A link that carries a transaction
   teaches people to open signing links received in messages, and it lands in browser history and sync. A
   QR code tops out at 2,953 bytes (Section 2), which a transaction with many signer removals and
   signatures can exceed once base64 adds a third. It would work only some of the time and would need
   camera access. The artifact never carries a URL.
2. **No SEP-7 URIs.** Without `callback`, the wallet signs and submits, which skips the hub and skips
   LumenWipe's `verify()` on the cosigner's device. With `callback`, a server would receive signed
   envelopes, which this design excludes. A cosigner whose wallet supports SEP-7 can still sign through the
   station with WalletConnect.
3. **Validity: 300 seconds in v1**, with the floors and the rebuild in Section 8.1.
4. **Requests are unsigned, and responses carry only the station's signatures.** The hash excludes
   signatures, so signatures merge on the hub, which attaches a minimal set (check 7.3f).
5. **No storage of a partly signed envelope across a hub reload in v1.** It lives 300 seconds at most.
   Storing it would create a stored, partly authorized transaction and a restore path that must verify it
   again, for the gain of saving one signature.
6. **The station signs only signer normalization in v1** (Sections 3.1 and 7.2). No conversion, exit,
   claim, payment or merge.
7. **One hub, stateless stations** (Section 3). The hub holds the master key.
8. **The cosigner types the account and the fingerprint.** The account before import, so an artifact for
   another account is refused. The fingerprint, read out by the initiator, so a request swapped in transit
   is refused. The hub never puts the fingerprint in the export.

## 12. Interim statement

Until this design ships, the review screen and the multisig notice on the signing step say (built by
`apps/web/lib/stellar/cosign-requirement.ts`):

> This account needs signatures from at least N of its M keys, on K transactions of this close. These N must
> sign here, in this browser, during this close. Signing from another device is not supported yet.

When N equals M, the first sentence reads "all M of its keys". When a transaction of the close removes
signers without merging the account (`assertMasterSignsSignerRemoval` applies), it adds:

> One transaction removes the other signers without closing the account, so the master key,
> `<first 8>…<last 8>`, must be one of these N. After it, the master key alone completes the close.

Rules:

- **M** counts the account's `ed25519_public_key` signers with weight above 0. A signer with weight 0
  cannot sign and is not counted.
- **N** is the smallest number of those keys whose weights together reach the signing threshold of the
  close (at least 1), counted from the heaviest key down. That threshold is the high one, raised to the
  medium or low threshold of any transaction before the removal when that one is higher: Stellar allows a
  medium threshold above the high one, and the same N sign every transaction up to the removal. Without a
  breakdown the plan may hold a DeFi exit, so the medium threshold counts. When the master key is required, N
  counts it among the N. The statement shows only when N is 2 or more, or when the keys alone cannot reach
  the threshold.
- **The master key** is required when the plan's transaction that covers `NORMALIZE_SIGNERS` does not also
  cover `MERGE`. Without a breakdown, an exchange close through the relay account requires it, and a direct
  close says instead: "If a transaction removes the other signers before the final transaction, the master
  key, `<first 8>…<last 8>`, must sign it as well."
- **K** counts, among the plan's transactions up to and including the one that covers `NORMALIZE_SIGNERS`,
  those whose own signing weight one key cannot reach. The removal transaction needs the high threshold.
  Each earlier one is judged against the threshold category of what it covers, as the signing step judges
  it (`requiredSignatureWeight`): low for a claim round that only claims, high for anything that touches
  signers or merges, medium otherwise. The order comes only from the breakdown's `order` field, so K stays
  correct when the removal moves to its own first transaction. When the plan gives no breakdown, or none
  covers `NORMALIZE_SIGNERS`, the first sentence ends "for this close" and states no count.
  An earlier version counted every transaction up to the removal. That count was false when the medium or
  low threshold is below the high one: such a transaction is signed by fewer keys than N.
- **hash(x) signers** are not keys that sign here and are not counted. When the account lists any, the
  statement adds: "It also has H hash(x) signers. A preimage is entered in this browser, and only on the
  step that removes its own signer."
- **Pre-authorized transaction signers** are not keys that sign here and are not counted. When the account
  lists any, it adds: "It also has P pre-authorized transaction signers. Each is used by submitting that
  exact transaction in this browser, not by signing."
- **Signed-payload signers** are not counted. When the account lists any, it adds: "It also has S
  signed-payload signers, which cannot sign in LumenWipe."
- When the ed25519 keys together cannot reach the high threshold, the first two sentences become: "This
  account's keys alone cannot reach the signing weight this close needs. It also needs its hash(x) or
  pre-authorized transaction signers, used in this browser. Its keys must also sign here, in this browser,
  during this close." When the account has no hash(x) or pre-authorized transaction signers either, the
  plan is blocked and no statement is shown.

## 13. Invariants the build would add

Proposed rows for the [invariant register](/invariants), added with the implementation and not before:

- The station never submits a transaction.
- An artifact carries no expectations and no URL. A request carries no signatures.
- The hub uses only verified ed25519 signatures from signers of the round, attaches a minimal set, and
  never uses a received transaction body.
- A device signs a received transaction only after `verify()` and the approved-hash check pass on that
  device, with `preAuthorized: false` on the station.
- The station sends the API only the network and the account address.

The last proposed row, that for a multisig close signer normalization is its own first transaction, is in
the register as INV-51.

The [threat model](/threat-model) gains the station as part of the client-side key handling surface in the
same change.

## 14. Security design review

Reviewed on 2026-11-07, on the draft written against commit `f369477` of `main`.

**Verdict: approved with required changes.** All the changes are made in this revision.

Decisions on the questions put to the review:

1. **Validity window.** Keep 300 seconds for v1. The station reads the account before import, refuses
   below 90 seconds at import and 60 at signing, and the hub offers a rebuild on expiry (Section 8.1).
2. **Transfers confirmed by a person.** Not acceptable. Expectations decoded from the transaction being
   checked are circular. Transfers, trustlines and amounts are checked mechanically (Section 7.2).
3. **Conversions on the station.** Refused. With signer normalization as its own first transaction, the
   station signs only that transaction in v1 (Section 3.1).
4. **Checks the artifact can influence.** The account, the approved hash and the fingerprint could. The
   account is typed before import, the approved hash is stored at verify time, and the fingerprint is typed
   by the cosigner and never exported.
5. **Residual risk.** Restated: responses are bearer authorizations until `maxTime` (Section 9).

Findings and dispositions:

| #   | Finding                                                                                                                                                                                                                                                                                                          | Disposition                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Confirming transfers by a person is circular.                                                                                                                                                                                                                                                                    | Mechanical rules, Section 7.2.                                                             |
| 2   | The artifact's `account` was trusted.                                                                                                                                                                                                                                                                            | Typed before import, Sections 5, 6, 7.1d.                                                  |
| 3   | Signing a normalization without a merge hands the master key sole control, unstated.                                                                                                                                                                                                                             | Stated by the station, Sections 3.1, 5, 12.                                                |
| 4   | Merged signatures could never reach submission through today's engine.                                                                                                                                                                                                                                           | Two engine changes, check 7.3g, for review.                                                |
| 5   | Merging by contribution ignores unmatched signatures and can attach extras.                                                                                                                                                                                                                                      | Signature-by-signature check and a minimal set, 7.3c to 7.3f.                              |
| 6   | A fingerprint in the export proves nothing.                                                                                                                                                                                                                                                                      | Typed by the cosigner, never exported, Sections 4, 5, 7.1g.                                |
| 7   | Conversions share a transaction with signer removal, and every round before normalization needs full weight.                                                                                                                                                                                                     | Normalization first (API follow-up), Section 3.1; handoff count restated in 8.1.           |
| 8   | Text corrections: INV-38 is 330 seconds; the passphrase binds only through the hash; a rebuild leaves the old transaction valid; the sequence number does not guard signers; outside submissions are found by inner hash; responses are bearer authorizations; the station verifies with `preAuthorized: false`. | Corrected in Sections 2, 7.1b, 8, 9, 10.                                                   |
| 9   | A 30-second floor is below the submission budget.                                                                                                                                                                                                                                                                | 90 seconds at import, 60 at signing, Section 8.1.                                          |
| 10  | Phishing through links and origins.                                                                                                                                                                                                                                                                              | Exact origin in the instructions, wallets first, no URL in the artifact, Sections 4, 5, 6. |
| 11  | The interim statement was imprecise.                                                                                                                                                                                                                                                                             | "These N", the master key, T, signed-payload signers, Section 12.                          |
| 12  | The review outcome was not recorded.                                                                                                                                                                                                                                                                             | This section.                                                                              |
