# Contributing to LumenWipe

Thank you for your interest in contributing. LumenWipe performs irreversible operations on real Stellar accounts, so correctness and security matter more than speed. This guide explains how to contribute effectively and safely.

---

## Table of contents

1. [What we welcome](#1-what-we-welcome)
2. [Before you start](#2-before-you-start)
3. [Development setup](#3-development-setup)
4. [Code conventions](#4-code-conventions)
5. [Commit messages](#5-commit-messages)
6. [Branch naming](#6-branch-naming)
7. [Pull request process](#7-pull-request-process)
8. [Testing requirements](#8-testing-requirements)
9. [Contributing to registries](#9-contributing-to-registries)
10. [Reporting bugs](#10-reporting-bugs)
11. [Security issues](#11-security-issues)

---

## 1. What we welcome

| Contribution type          | Notes                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Bug fixes                  | Include a test that reproduces the bug before the fix                                                         |
| New DeFi protocol support  | Follow the exit adapter invariants in [docs/architecture.md](docs/architecture.md#99-exit-adapter-invariants) |
| Exchange registry entries  | See [Contributing to registries](#9-contributing-to-registries)                                               |
| Contract registry updates  | New `wasmHash` → protocol version mappings for supported protocols                                            |
| Documentation improvements | Fix errors, improve clarity, add missing details                                                              |
| Test coverage              | Unit tests for the transaction builder and edge cases are especially valuable                                 |
| UI improvements            | Stick to the existing component patterns; changes to confirmation flows require extra care                    |
| Translations               | Open an issue first to coordinate                                                                             |

If you are planning a large change — a new protocol integration, a significant refactor, a new feature — **open an issue first** to discuss the approach before writing code. This avoids effort going in a direction that won't be merged.

---

## 2. Before you start

- Read the [technical architecture](docs/architecture.md) to understand how the system is designed and why.
- For protocol integrations, read [Section 9](docs/architecture.md#9-closing-positions-classic-and-soroban-defi) and [Section 9.9](docs/architecture.md#99-exit-adapter-invariants) carefully. Every exit adapter must satisfy the invariants listed there.
- For security-sensitive changes (key handling, transaction construction, confirmation flows, the mediator flow), read [Section 13](docs/architecture.md#13-security-model) before touching that code.

---

## 3. Development setup

**Requirements:** [Bun](https://bun.sh) 1.3+, Node.js 20+

```bash
# Fork and clone the repository
git clone https://github.com/LumenWipe/lumenwipe.git
cd lumenwipe

# Install dependencies
bun install

# Copy environment file and configure
cp .env.example .env.local
# Edit .env.local — at minimum set STELLAR_RPC_URL to a testnet RPC endpoint

# Start the development server (testnet by default)
bun dev
```

Open [http://localhost:3000](http://localhost:3000). The app defaults to Stellar testnet — no real funds are at risk during development.

**Verify the setup:**

```bash
bun type-check   # TypeScript — must pass with zero errors
bun lint         # ESLint — must pass with zero errors
bun test         # Unit tests — must all pass
```

---

## 4. Code conventions

### TypeScript

- Strict mode is on. All code must type-check with zero errors (`bun type-check`).
- Avoid `any`. Use `unknown` with a type guard, or model the type properly.
- Prefer explicit return types on exported functions.

### Formatting

[Prettier](https://prettier.io) is authoritative. Run `bun format` before committing. The project config (`.prettierrc`):

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "es5",
  "printWidth": 100,
  "tabWidth": 2
}
```

### Comments

Write comments only when the **why** is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific protocol behavior. Do not describe what the code does; well-named identifiers do that.

### Error handling

- Validate at system boundaries (user input, external APIs). Trust internal code and SDK guarantees.
- Every error surfaced to the user must be in plain language. Never expose raw SDK error codes or stack traces to the UI.
- A position or step the tool cannot safely close must surface as a blocker with an explanation, never be silently skipped.

### Transaction builder

The transaction builder (`lib/stellar/tx-builder/`) is a pure module: account state in, unsigned transaction envelopes out, no network side effects. Keep it that way — it makes it directly unit-testable and auditable.

---

## 5. Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

**Types:**

| Type       | When to use                                                               |
| ---------- | ------------------------------------------------------------------------- |
| `feat`     | New functionality                                                         |
| `fix`      | Bug fix                                                                   |
| `test`     | Adding or improving tests                                                 |
| `docs`     | Documentation only                                                        |
| `refactor` | Code change that neither fixes a bug nor adds a feature                   |
| `chore`    | Dependency updates, tooling, config                                       |
| `security` | Security fix or hardening (use for key handling, CSP, validation changes) |

**Scopes** (optional, use when it helps): `builder`, `mediator`, `blend`, `aquarius`, `soroswap`, `phoenix`, `fxdao`, `registry`, `ui`, `backend`, `tests`, `deps`

**Examples:**

```
feat(blend): add V2 pool exit via blend-sdk Pool.submit
fix(mediator): require memo for known exchange destinations before submission
test(builder): add edge case for account with 1000 subentries
security(key-handling): clear secret key from memory after each signing operation
chore(registry): add Binance deposit address to exchange registry
```

Keep the summary under 72 characters. Use the body to explain the _why_ if it is not obvious from the diff.

---

## 6. Branch naming

```
<type>/<short-description>
```

Examples:

```
feat/phoenix-lp-exit
fix/mediator-memo-validation
test/blend-undercollateralized-vault
docs/architecture-soroban-section
chore/registry-kraken-address
```

---

## 7. Pull request process

1. **Open an issue first** for anything beyond a small fix or registry update.
2. **Fork** the repository and work on a branch, not directly on `main`.
3. **Keep PRs focused.** One logical change per PR. A PR that adds a new protocol exit should not also refactor unrelated code.
4. **Write tests.** New protocol adapters require integration tests against testnet. Bug fixes require a unit test reproducing the bug. See [Testing requirements](#8-testing-requirements).
5. **Pass all checks locally** before pushing:
   ```bash
   bun type-check && bun lint && bun test
   ```
6. **Fill in the PR description** completely:
   - What the change does and why
   - How it was tested
   - Any risk or edge cases the reviewer should pay attention to
   - For protocol changes: which invariants in [Section 9.9](docs/architecture.md#99-exit-adapter-invariants) are satisfied and how
7. **Security-sensitive changes** (key handling, transaction construction, confirmation flows, mediator flow, CSP) require extra description and will receive closer review. Flag them explicitly.
8. A maintainer will review your PR. Be prepared for back-and-forth — the review is thorough because the operations are irreversible.
9. Squash commits if requested before merge.

---

## 8. Testing requirements

The test suite has two tiers. Automated tests **never touch mainnet**.

### Unit tests (`tests/unit/`)

Run with `bun test`. Test pure logic with deterministic fixtures: transaction construction, fee estimation, reserve math, routing parameter derivation, state machine transitions, input validation, batching. The transaction builder (`lib/stellar/tx-builder/`) is the highest-coverage module and new logic there must be unit-tested.

```bash
bun test              # run all unit tests
bun test:watch        # watch mode during development
```

### End-to-end tests (`tests/e2e/`)

Run with `bun test:e2e`. Playwright drives a real browser against **testnet** through full flows: account analysis, each step category, the mediator flow, session recovery. New protocol integrations require a matching E2E test that executes the full exit against a testnet account with a real position.

```bash
bun test:e2e
```

### What to test for a new protocol exit

At minimum:

- Normal exit: position detected, exit transaction built, simulated, and submitted correctly on testnet
- No position: adapter returns no steps when the account has no position in this protocol
- Unknown `wasmHash`: adapter flags the position for manual review instead of building an exit
- Clamp to balance: exit does not over-withdraw (amount larger than position is clamped)
- Repay before withdraw (for lending protocols): debt is repaid before collateral is touched

---

## 9. Contributing to registries

The exchange registry and contract registry are versioned JSON files. Updates to these are the most common and lowest-risk contribution, and they follow a simple process.

### Exchange registry

Maps known exchange and anchor deposit addresses to whether they need the mediator flow, and what memo type is required.

To add an exchange:

1. Find the exchange's official Stellar deposit address documentation.
2. Determine the memo type they require (`text`, `id`, `hash`, or none).
3. Open a PR that adds the entry to the registry JSON with a link to the source documentation in the PR description.
4. A maintainer will verify the address and merge.

### Contract registry

Maps Soroban contract `wasmHash` values to a known protocol version so the tool can pick the correct exit interface.

To update after a protocol upgrade:

1. Get the new `wasmHash` from the deployed contract on mainnet.
2. Open a PR that adds the mapping to the registry.
3. Include in the PR description: the contract address, the `wasmHash`, the source (deploy transaction or protocol team announcement), and which adapter version handles it.

Registry updates go through the same PR review as code changes.

---

## 10. Reporting bugs

Open a [GitHub Issue](https://github.com/LumenWipe/lumenwipe/issues) with:

- A clear description of the unexpected behavior
- Steps to reproduce (network, account type, which step failed)
- What you expected to happen
- What actually happened (error message, transaction hash if applicable)
- Whether this was on testnet or mainnet

**Do not include private keys or seed phrases in bug reports.** If a key was exposed, treat it as compromised and rotate it immediately.

---

## 11. Security issues

**Do not open a public issue for security vulnerabilities.**

Report them privately following the process in [SECURITY.md](SECURITY.md).
