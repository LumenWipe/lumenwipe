# Security Policy

LumenWipe performs irreversible operations on Stellar accounts - it removes trustlines, cancels offers, exits DeFi positions, and merges accounts. A security vulnerability could result in permanent loss of user funds. We take this seriously and are committed to addressing security reports promptly and transparently.

---

## Table of contents

1. [Supported versions](#1-supported-versions)
2. [Reporting a vulnerability](#2-reporting-a-vulnerability)
3. [Response timeline](#3-response-timeline)
4. [Scope](#4-scope)
5. [Out of scope](#5-out-of-scope)
6. [Disclosure policy](#6-disclosure-policy)
7. [Security reviews](#7-security-reviews)
8. [Security design principles](#8-security-design-principles)

---

## 1. Supported versions

| Version                | Supported           |
| ---------------------- | ------------------- |
| `main` branch (latest) | Yes                 |
| Previous releases      | Critical fixes only |

We recommend always using the latest version.

---

## 2. Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Public disclosure before a fix is available puts users at risk.

**To report a vulnerability, email:**

> **security@lumenwipe.com**

Include in your report:

- A clear description of the vulnerability
- The component affected (see [Scope](#4-scope) for the list)
- Steps to reproduce, or a proof of concept if you have one
- The potential impact - what an attacker could do and under what conditions
- Your preferred disclosure timeline, if any

You will receive an acknowledgment within **48 hours**. If you do not hear back within that window, follow up by opening a GitHub issue with the title "Security contact - please check email" and no further details.

---

## 3. Response timeline

| Milestone                                      | Target                               |
| ---------------------------------------------- | ------------------------------------ |
| Acknowledgment                                 | 48 hours after report                |
| Initial assessment (confirmed / not confirmed) | 5 business days                      |
| Status update                                  | Every 7 days while the issue is open |
| Fix for critical / high severity               | Before public disclosure             |
| Fix for medium severity                        | Within 30 days                       |
| Fix for low severity                           | Next regular release                 |

We will coordinate the public disclosure date with you. We ask for a minimum of **14 days** after a fix is deployed before public disclosure, to allow users to update.

---

## 4. Scope

The following components are in scope for security reports:

| Component                      | Examples of in-scope issues                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Key handling**               | Secret key leaking outside browser memory, persisted to `localStorage` / `sessionStorage` / IndexedDB / network requests, logged, or exposed in error messages                                              |
| **Transaction construction**   | Operations encoded incorrectly (wrong destination, wrong amount, wrong memo), fee manipulation, envelope tampering                                                                                          |
| **Signing flow**               | User signing a transaction they did not review; auto-submission without explicit user confirmation; multisig signature accumulation leaking a partial key                                                   |
| **Mediator co-sign**           | The API co-signing anything other than the validated merge-and-forward pair, a forward larger than the merged balance, a forward to the wrong destination, or a missing or wrong memo for a listed exchange |
| **Allowance inspector**        | Incorrect allowance data leading a user to believe an approval was revoked when it was not                                                                                                                  |
| **Content Security Policy**    | Bypasses that allow injected scripts to execute in the application context                                                                                                                                  |
| **XSS**                        | Cross-site scripting that could read the in-memory key or intercept a signing operation                                                                                                                     |
| **Backend key boundary**       | Any path by which the API receives a user's private key, signs for a user's account, or uses the mediator or sponsor key outside its validated shape                                                        |
| **Session store**              | Sensitive data (keys, signed envelopes) written to IndexedDB or any persistent browser storage                                                                                                              |
| **Dependency vulnerabilities** | High or critical CVEs in direct dependencies that affect the signing or transaction construction surface                                                                                                    |
| **DeFi exit correctness**      | Exit adapter building a transaction that would drain more funds than the user's position, or skipping a repayment that leaves a protocol in an unsafe state                                                 |

---

## 5. Out of scope

The following are not considered security vulnerabilities for this project:

- Vulnerabilities in the Stellar protocol itself, Stellar RPC, or third-party data services (stellar.expert, OctoPos, Orion, Soroswap API) - report those to the respective projects
- Phishing sites that impersonate LumenWipe - report these to us for awareness, but they are not code vulnerabilities
- Denial of service against the API: it holds no user funds or user keys, so disrupting it affects availability, not custody. Draining the fee-bump sponsor or the mediator is in scope
- Social engineering attacks
- Issues requiring physical access to the user's device
- Vulnerabilities in browsers that LumenWipe cannot control
- Self-XSS (the attacker must already control the victim's browser session)
- Rate-limiting bypass on the read-only backend (no funds at risk)
- Missing `Secure` / `HttpOnly` flags on non-sensitive cookies
- Clickjacking where no sensitive action can be triggered in a single click without user review

If you are unsure whether an issue is in scope, report it and we will assess it.

---

## 6. Disclosure policy

We follow a **coordinated disclosure** model:

1. You report the vulnerability to us privately.
2. We confirm receipt within 48 hours and provide an initial assessment within 5 business days.
3. We work with you to understand and reproduce the issue.
4. We develop and test a fix. For critical and high severity issues, the fix is deployed before any public disclosure.
5. We coordinate a disclosure date with you - typically **14–30 days** after the fix is deployed, depending on severity and user exposure.
6. We publish a security advisory on GitHub with the vulnerability details, the fix, and a credit to you (unless you prefer to remain anonymous).

We do not pursue legal action against researchers who report vulnerabilities in good faith and follow this policy.

**Credit:** Security researchers who responsibly report valid vulnerabilities are credited in the advisory and in the repository's security acknowledgments.

---

## 7. Security reviews

The codebase undergoes internal security reviews as part of our development process. External security audits will be conducted when possible.

---

## 8. Security design principles

Understanding the security model helps you identify which issues are most impactful. The full model is in [docs/architecture.md - Section 13](docs/architecture.md#13-security-model). In brief:

**Private keys never leave the browser.**
The primary signing path uses [stellar-wallets-kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit), which means the application never sees the private key at all. The advanced secret-key mode keeps the key in memory only, never in `localStorage`, `sessionStorage`, IndexedDB, cookies or any network request, for the current close, and wipes it on completion, on abort, on leaving the flow, or when you choose Forget key.

**The backend never signs for a user's account.**
It builds unsigned transactions and holds only two narrow service keys: the shared mediator, which co-signs one validated forward payment, and the fee-bump sponsor, which signs only the outer fee-bump envelope. A compromised backend could return a transaction that does not match the user's choices, which client-side verification refuses before signing, or wrong read data (amounts, positions, quotes), which the user reviews; the [threat model](docs/threat-model.md) lists what that leaves.

**Every destructive step requires explicit user confirmation.**
The tool never auto-submits. Users confirm each step after reviewing what it does, see the XDR, and in the case of the final merge, confirm the full destination address on a dedicated confirmation screen.

**The mediator's signing key never leaves the API's environment.**
The shared mediator account exists to receive exchange-bound merges and forward them on; its secret is configured server-side only (`MEDIATOR_SECRET_*`) and is never transmitted to or generated in the browser. The API co-signs only the exact `[accountMerge → mediator, payment mediator → destination]` shape the user already built and signed, and only after validating that shape and bounding the forward amount against the merged account's own balance - it can neither sign for a user's account nor redirect the forward payment. See [docs/architecture.md - Section 11](docs/architecture.md#11-the-mediator-account-flow-for-exchanges) and the [threat model](docs/threat-model.md) (Section 5) for the full design.

**Strict Content Security Policy.**
In production a script runs only with the per-request nonce or when loaded by one that has it (`strict-dynamic`), with no `unsafe-eval` and no `unsafe-inline` for scripts. Any XSS payload that cannot execute JavaScript cannot intercept the in-memory key or signing operations.

**Security response headers on every route.**
Pages and the `/api` routes alike carry HSTS (two years, including subdomains, not preloaded), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that allows only clipboard writes and the video embed's fullscreen, and `Cross-Origin-Opener-Policy: same-origin-allow-popups`, which keeps the popup wallets working. CSP violations are reported to `/api/csp-report`, which logs only the violated directive and the blocked origin, never the page URL or any sample ([`apps/web/config/security-headers.mjs`](apps/web/config/security-headers.mjs)).
