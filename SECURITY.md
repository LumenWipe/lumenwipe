# Security Policy

LumenWipe performs irreversible operations on Stellar accounts — it removes trustlines, cancels offers, exits DeFi positions, and merges accounts. A security vulnerability could result in permanent loss of user funds. We take this seriously and are committed to addressing security reports promptly and transparently.

---

## Table of contents

1. [Supported versions](#1-supported-versions)
2. [Reporting a vulnerability](#2-reporting-a-vulnerability)
3. [Response timeline](#3-response-timeline)
4. [Scope](#4-scope)
5. [Out of scope](#5-out-of-scope)
6. [Disclosure policy](#6-disclosure-policy)
7. [Security audit commitment](#7-security-audit-commitment)
8. [Security design principles](#8-security-design-principles)

---

## 1. Supported versions

| Version                | Supported           |
| ---------------------- | ------------------- |
| `main` branch (latest) | Yes                 |
| Previous releases      | Critical fixes only |

We recommend always using the latest version. If you are self-hosting, keep your deployment up to date with the `main` branch.

---

## 2. Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Public disclosure before a fix is available puts users at risk.

**To report a vulnerability, email:**

> **security@lumenwipe.com**

Include in your report:

- A clear description of the vulnerability
- The component affected (see [Scope](#4-scope) for the list)
- Steps to reproduce, or a proof of concept if you have one
- The potential impact — what an attacker could do and under what conditions
- Your preferred disclosure timeline, if any

**PGP encryption** (recommended for sensitive reports): a PGP public key is published at [lumenwipe.com/.well-known/security.txt](https://lumenwipe.com/.well-known/security.txt).

You will receive an acknowledgment within **48 hours**. If you do not hear back within that window, follow up by opening a GitHub issue with the title "Security contact — please check email" and no further details.

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

We will coordinate the public disclosure date with you. We ask for a minimum of **14 days** after a fix is deployed before public disclosure, to allow users and self-hosters to update.

---

## 4. Scope

The following components are in scope for security reports:

| Component                       | Examples of in-scope issues                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Key handling**                | Secret key leaking outside browser memory, persisted to `localStorage` / `sessionStorage` / IndexedDB / network requests, logged, or exposed in error messages |
| **Transaction construction**    | Operations encoded incorrectly (wrong destination, wrong amount, wrong memo), fee manipulation, envelope tampering                                             |
| **Signing flow**                | User signing a transaction they did not review; auto-submission without explicit user confirmation; multisig signature accumulation leaking a partial key      |
| **Mediator account flow**       | Mediator keypair persisted, reused, or sent to the backend; funds forwarded to the wrong destination; memo validation bypass for known exchange destinations   |
| **Allowance inspector**         | Incorrect allowance data leading a user to believe an approval was revoked when it was not                                                                     |
| **Content Security Policy**     | Bypasses that allow injected scripts to execute in the application context                                                                                     |
| **XSS**                         | Cross-site scripting that could read the in-memory key or intercept a signing operation                                                                        |
| **Backend read-only guarantee** | Any path by which the backend receives a private key, a signed envelope with key material, or can influence a transaction without user awareness               |
| **Session store**               | Sensitive data (keys, signed envelopes) written to IndexedDB or any persistent browser storage                                                                 |
| **Dependency vulnerabilities**  | High or critical CVEs in direct dependencies that affect the signing or transaction construction surface                                                       |
| **DeFi exit correctness**       | Exit adapter building a transaction that would drain more funds than the user's position, or skipping a repayment that leaves a protocol in an unsafe state    |

---

## 5. Out of scope

The following are not considered security vulnerabilities for this project:

- Vulnerabilities in the Stellar protocol itself, Stellar RPC, or third-party data services (stellar.expert, OctoPos, Orion, Soroswap API) — report those to the respective projects
- Phishing sites that impersonate LumenWipe — report these to us for awareness, but they are not code vulnerabilities
- Denial of service against the read-only backend — the backend holds no funds or keys; disrupting it affects availability, not security
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
5. We coordinate a disclosure date with you — typically **14–30 days** after the fix is deployed, depending on severity and user exposure.
6. We publish a security advisory on GitHub with the vulnerability details, the fix, and a credit to you (unless you prefer to remain anonymous).

We do not pursue legal action against researchers who report vulnerabilities in good faith and follow this policy.

**Credit:** Security researchers who responsibly report valid vulnerabilities are credited in the advisory and in the repository's security acknowledgments.

---

## 7. Security audit commitment

Given the irreversible nature of the operations, LumenWipe commits to a third-party security audit **before any mainnet launch**.

- The audit is coordinated through [Stellar's Audit Bank](https://stellar.org/blog/developers/introducing-the-stellar-audit-bank) where possible.
- **Audit scope:** key handling surface, CSP and XSS surface, transaction construction logic (operation encoding, fee estimation, envelope handling), the mediator flow, and the DeFi exit adapters.
- **Critical and high findings** are remediated before public mainnet launch.
- **All findings and their remediation status** are published in the repository, regardless of severity.

Progress toward the audit and its results will be announced on the project's public channels.

---

## 8. Security design principles

Understanding the security model helps you identify which issues are most impactful. The full model is in [docs/architecture.md — Section 13](docs/architecture.md#13-security-model). In brief:

**Private keys never leave the browser.**
The primary signing path uses [stellar-wallets-kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit), which means the application never sees the private key at all. The advanced secret-key mode keeps the key in memory only — never in `localStorage`, `sessionStorage`, IndexedDB, cookies, or any network request — and clears it immediately after each signing operation.

**The backend is read-only and never in the signing path.**
A fully compromised backend could return incorrect read data, but it cannot sign transactions, move funds, or access keys. Wrong read data is defended against by on-chain simulation and explicit user confirmation before every destructive step.

**Every destructive step requires explicit user confirmation.**
The tool never auto-submits. Users confirm each step after reviewing what it does, see the XDR, and in the case of the final merge, confirm the full destination address on a dedicated confirmation screen.

**The mediator keypair is ephemeral.**
It is generated in the browser, used once to sign the forward payment, and then nulled from memory. Only its public key is recorded in the session for transparency and recovery.

**Strict Content Security Policy.**
No inline scripts, no `unsafe-eval`. Any XSS payload that cannot execute JavaScript cannot intercept the in-memory key or signing operations.
